import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpAuthRecord } from "../shared/http-auth.js";
import { resolveHttpApiRoute } from "../shared/http-operation-policy.js";
import { ServiceError } from "./errors.js";
import {
  readBufferBody,
  readJsonBody,
  readTextBody,
  sendJson,
  waitForResponseSettlement
} from "./http.js";

import { MAX_IMPORT_BYTES } from "./import-model.js";
import {
  decodeMarkdownHttpBody,
  MAX_MARKDOWN_HTTP_BODY_BYTES
} from "../shared/import-markdown-wire.js";
import type { StoryService } from "./story-service.js";
import { streamResponse } from "./stream-response.js";
import { optionalString, requireNumberValue, requireString, requireStringValue } from "./validation.js";
import {
  requireAnyHttpCapability,
  requireHttpCapability
} from "./http-authorization.js";
import type { HttpOperationSessionStore } from "./http-operation-sessions.js";
import {
  applyCorsResponseHeaders,
  handleCorsPreflight
} from "./http-cors.js";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_SERVER_INSTANCE_HEADER
} from "../shared/http-protocol.js";
import { AI_1667_BUILD_IDENTITY } from "../shared/build-identity.js";
import type {
  MutatingWorkerMethod
} from "../shared/worker-protocol.js";
import { runHttpOperationMutation } from "./http-operation-mutation.js";
import {
  handleHttpOperationControl,
  requireHttpOperationTicket,
  requireOperationSessionCapability
} from "./http-operation-control.js";
import {
  parseCanonicalApiPath,
  requireCompatibleHttpClient,
  requireCurrentHttpServerInstance
} from "./http-router-protocol.js";
import { httpRecoveryWarnings } from "./http-recovery-warnings.js";
import {
  createHttpServerProof,
  HTTP_SERVER_PROOF_HEADER,
  HTTP_SERVER_PROOF_PATH,
  isHttpServerProofNonce
} from "../shared/http-server-proof.js";
import type { InternalErrorReporter } from "./internal-error-reporter.js";
import type {
  HttpDataDirectoryIdentity
} from "./data-directory-id.js";
export interface HttpRouterContext {
  readonly authRecord: HttpAuthRecord;
  readonly dataDirectoryIdentity: HttpDataDirectoryIdentity | null;
  readonly developmentOrigin: string | null;
  readonly service: StoryService | null;
  readonly errorReporter: InternalErrorReporter;
  readonly operationSessions: HttpOperationSessionStore;
  readonly mutationGate?: HttpMutationGate;
}

export interface HttpMutationGate {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export async function handleHttpRequest(
  context: HttpRouterContext,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const host = request.headers.host ?? "";
  if (host !== new URL(context.authRecord.origin).host) {
    throw new ServiceError(403, "Forbidden host");
  }
  const method = request.method ?? "GET";
  const origin = request.headers.origin;
  const sameOrigin = origin === undefined || origin === context.authRecord.origin;
  const allowedDevelopmentOrigin = origin === context.developmentOrigin;
  if (!sameOrigin && !allowedDevelopmentOrigin) {
    throw new ServiceError(403, "Forbidden origin");
  }
  applyCorsResponseHeaders(request, response, context.developmentOrigin);
  if (handleCorsPreflight(request, response, context.developmentOrigin)) return;
  const url = new URL(request.url ?? "/", context.authRecord.origin);
  if (url.pathname === "/.well-known/1667-instance" && method === "GET") {
    return sendJson(response, 200, {
      schema: 1,
      origin: context.authRecord.origin,
      instanceId: context.authRecord.instanceId
    });
  }
  if (url.pathname === HTTP_SERVER_PROOF_PATH && method === "HEAD") {
    const nonce = url.searchParams.get("nonce");
    if (nonce === null
      || url.searchParams.size !== 1
      || !isHttpServerProofNonce(nonce)
      || url.search !== `?nonce=${nonce}`) {
      throw new ServiceError(400, "Invalid server-proof challenge");
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader(HTTP_SERVER_PROOF_HEADER, createHttpServerProof(
      context.authRecord,
      nonce
    ));
    response.statusCode = 204;
    response.end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    return await handleApi(context, request, response, url.pathname);
  }
  throw new ServiceError(404, `No route: ${method} ${url.pathname}`);
}

async function handleApi(
  context: HttpRouterContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<void> {
  const method = request.method ?? "GET";
  const segments = parseCanonicalApiPath(pathname);
  const [rawHead, id, sub, subId, action] = segments;
  response.setHeader(
    HTTP_SERVER_INSTANCE_HEADER,
    context.authRecord.instanceId
  );
  if (rawHead === "health"
    && id === undefined
    && method === "GET") {
    requireCurrentHttpServerInstance(request, context.authRecord.instanceId);
    const capabilityScope = requireAnyHttpCapability(
      request,
      context.authRecord
    );
    if (context.service === null
      || context.dataDirectoryIdentity === null
      || !context.operationSessions.isAdmissionOpen()) {
      return sendJson(response, 503, { error: "1667 is still opening its data" });
    }
    return sendJson(response, 200, {
      ok: true,
      buildIdentity: AI_1667_BUILD_IDENTITY,
      ...context.dataDirectoryIdentity,
      serverInstanceId: context.authRecord.instanceId,
      recoveryWarnings: httpRecoveryWarnings(
        context.service,
        capabilityScope
      )
    });
  }
  if (rawHead === "operations") {
    requireCompatibleHttpClient(request);
    requireCurrentHttpServerInstance(request, context.authRecord.instanceId);
    return await handleHttpOperationControl(
      context,
      request,
      response,
      pathname,
      method
    );
  }
  requireCompatibleHttpClient(request);
  requireCurrentHttpServerInstance(request, context.authRecord.instanceId);
  let protectedRoute: ReturnType<typeof resolveHttpApiRoute>;
  try {
    protectedRoute = resolveHttpApiRoute(method, pathname);
  } catch {
    context.operationSessions.authenticate(
      requireOperationSessionCapability(request)
    );
    throw new ServiceError(404, `No route: ${method} ${pathname}`);
  }
  const service = context.service;
  if (service === null) {
    throw new ServiceError(
      503,
      "1667 is still opening its data",
      "resource_busy"
    );
  }
  const head = protectedRoute.head;

  const capability = requireOperationSessionCapability(request);
  const ticket = requireHttpOperationTicket(request);
  const operation = context.operationSessions.begin(
    capability,
    ticket,
    method,
    pathname
  );
  if (operation.scope !== protectedRoute.scope) {
    operation.finish("failed");
    throw new ServiceError(
      403,
      `The ${protectedRoute.scope} operation-session scope is required`,
      "forbidden"
    );
  }

  const route = async (): Promise<void> => {
  const jsonBody = () => readJsonBody(request, operation.signal);
  const textBody = (maxBytes: number) =>
    readTextBody(request, maxBytes, operation.signal);
  const mutate = <M extends MutatingWorkerMethod>(
    workerMethod: M,
    input: unknown,
    onDelta?: (text: string) => void,
    signal = operation.signal
  ) => {
    if (operation.mutationId === null) {
      throw new ServiceError(
        500,
        "HTTP mutation reached service without durable identity"
      );
    }
    if (operation.expectedAggregateVersion === null) {
      throw new ServiceError(
        500,
        "HTTP story mutation reached service without an aggregate version"
      );
    }
    return runHttpOperationMutation(
      service,
      operation.mutationId,
      workerMethod,
      input,
      signal,
      ticket,
      operation.expectedAggregateVersion,
      onDelta
    );
  };
  if (head === "settings" && id === undefined) {
    if (method === "GET") return sendJson(response, 200, await service.getSettings());
    if (method === "PUT") {
      const command = await jsonBody();
      requireCommandMutationId(command, operation.mutationId);
      return sendJson(response, 200, await service.saveSettings({
        ...command,
        transportOperationId: ticket
      }));
    }
  }
  if (head === "settings" && id === "pending" && method === "DELETE") {
    const command = await jsonBody();
    requireCommandMutationId(command, operation.mutationId);
    return sendJson(response, 200, await service.discardPendingSettings({
      ...command,
      transportOperationId: ticket
    }));
  }
  if (head === "settings" && id === "probe-context" && method === "POST") {
    return sendJson(
      response,
      200,
      await service.probeContextWindow(await jsonBody(), operation.signal)
    );
  }
  if (head === "settings" && id === "check-server" && method === "POST") {
    return sendJson(
      response,
      200,
      await service.checkModelServer(await jsonBody(), operation.signal)
    );
  }
  if (head === "settings" && id === "discover-models" && method === "POST") {
    return sendJson(
      response,
      200,
      await service.discoverModels(await jsonBody(), operation.signal)
    );
  }

  if (head === "stories" && id === undefined) {
    if (method === "GET") return sendJson(response, 200, await service.listStories());
    if (method === "POST") {
      const title = (optionalString((await jsonBody()).title) ?? "").trim() || "Untitled";
      return sendJson(response, 201, await mutate("createStory", { title }));
    }
  }
  // A read, but the query travels in a body: it is the writer's own prose and
  // must not land in a URL, a log line, or a proxy cache key.
  if (head === "stories" && id === "search" && method === "POST") {
    return sendJson(
      response,
      200,
      await service.searchStories(await jsonBody(), operation.signal)
    );
  }
  if (head === "stories" && id === "catalog-page" && method === "POST") {
    return sendJson(response, 200, await service.listStoriesPage(
      await jsonBody()
    ));
  }
  if (head === "stories" && id !== undefined && sub === undefined) {
    if (method === "GET") return sendJson(response, 200, await service.loadStory(id));
    if (method === "DELETE") return sendJson(response, 200, await mutate("deleteStory", { id }));
    if (method === "PATCH") {
      const title = requireString((await jsonBody()).title, "title").trim();
      return sendJson(response, 200, await mutate("renameStory", { id, title }));
    }
  }
  if (head === "stories" && id !== undefined
    && sub === "authors-note" && method === "PUT") {
    const body = await jsonBody();
    return sendJson(
      response,
      200,
      await mutate("setAuthorsNote", {
        storyId: id,
        note: requireStringValue(body.note, "note"),
        ...(body.depth === undefined ? {} : { depth: requireNumberValue(body.depth, "depth") })
      })
    );
  }

  if (head === "stories" && id !== undefined
    && sub === "author-brief" && method === "PUT") {
    const body = await jsonBody();
    return sendJson(
      response,
      200,
      await mutate("setAuthorBrief", {
        storyId: id,
        brief: requireStringValue(body.brief, "brief")
      })
    );
  }
  if (head === "stories" && id !== undefined
    && sub === "facts-budget" && method === "PUT") {
    const body = await jsonBody();
    return sendJson(
      response,
      200,
      await mutate("setFactsBudget", {
        storyId: id,
        budgetTokens: body.budgetTokens
      })
    );
  }

  if (head === "import" && id === "sillytavern" && sub === undefined && method === "POST") {
    return sendJson(
      response,
      201,
      await mutate("importSillyTavern", {
        jsonl: await textBody(MAX_IMPORT_BYTES)
      })
    );
  }

  if (head === "import" && id === "novelai" && sub === undefined && method === "POST") {
    return sendJson(
      response,
      201,
      await mutate("importNovelAI", {
        storyContainerJson: await textBody(MAX_IMPORT_BYTES)
      })
    );
  }

  if (head === "import" && id === "scenario" && sub === undefined && method === "POST") {
    return sendJson(
      response,
      201,
      await mutate("importScenario", {
        jsonText: await textBody(MAX_IMPORT_BYTES)
      })
    );
  }

  if (head === "import" && id === "markdown" && sub === undefined && method === "POST") {
    const framedBody = await textBody(MAX_MARKDOWN_HTTP_BODY_BYTES);
    let decoded: ReturnType<typeof decodeMarkdownHttpBody>;
    try {
      decoded = decodeMarkdownHttpBody(framedBody);
    } catch (error) {
      throw new ServiceError(400, error instanceof Error ? error.message : "Invalid Markdown import");
    }
    const { markdown, defaultTitle } = decoded;
    if (Buffer.byteLength(markdown) > MAX_IMPORT_BYTES) {
      throw new ServiceError(413, "Request body too large");
    }
    return sendJson(
      response,
      201,
      await mutate("importMarkdown", {
        markdown,
        ...(defaultTitle !== undefined ? { defaultTitle } : {})
      })
    );
  }

  if (head === "stories" && id !== undefined && sub === "switch" && method === "POST") {
    const body = await jsonBody();
    const nodeId = requireString(body.nodeId, "nodeId");
    const { nodeId: _discarded, ...options } = body;
    return sendJson(
      response,
      200,
      await mutate("switchLine", { storyId: id, nodeId, options })
    );
  }
  if (head === "stories" && id !== undefined && sub === "continue" && method === "POST") {
    const body = await jsonBody();
    return await streamResponse(request, response,
      (onDelta, signal) => mutate("continueStory", {
        storyId: id,
        instruction: requireStringValue(body.instruction, "instruction"),
        genId: requireString(body.genId, "genId"),
        target: {
          ...(body.parentId === undefined ? {} : {
            parentId: body.parentId as string | null
          }),
          ...(body.appendTo === undefined ? {} : {
            appendTo: requireString(body.appendTo, "appendTo")
          }),
          ...(body.expectedTextHash === undefined ? {} : {
            expectedTextHash: requireString(
              body.expectedTextHash,
              "expectedTextHash"
            )
          })
        }
      }, onDelta, signal),
      (result) => ({ type: "done", story: result.payload, droppedFacts: result.droppedFacts }),
      operation.signal,
      context.errorReporter,
      "continueStory");
  }
  if (head === "stories" && id !== undefined && sub === "summary-take" && method === "POST") {
    const body = await jsonBody();
    return await streamResponse(request, response,
      (onDelta, signal) => mutate(
        "createSummaryTake",
        {
          storyId: id,
          body
        },
        onDelta,
        signal
      ),
      (nodeId) => ({ type: "done", nodeId }),
      operation.signal,
      context.errorReporter,
      "createSummaryTake");
  }
  if (head === "stories" && id !== undefined && sub === "chapter-breaks") {
    if (subId === undefined && method === "POST") {
      const body = await jsonBody();
      const title = body.title === undefined ? "" : requireStringValue(body.title, "title");
      return sendJson(response, 201, await mutate("createChapterBreak", {
        storyId: id,
        parentPartId: requireString(body.parentPartId, "parentPartId"),
        title
      }));
    }
    if (subId !== undefined && action === undefined && method === "PATCH") {
      const title = requireStringValue((await jsonBody()).title, "title");
      return sendJson(response, 200, await mutate("renameChapterBreak", {
        storyId: id,
        breakId: subId,
        title
      }));
    }
    if (subId === undefined && action === undefined && method === "PATCH") {
      const title = requireStringValue((await jsonBody()).title, "title");
      return sendJson(response, 200, await mutate("renameChapterBreak", {
        storyId: id,
        breakId: null,
        title
      }));
    }
    if (subId !== undefined && action === undefined && method === "DELETE") {
      const removedFingerprint = requireString(
        (await jsonBody()).removedFingerprint,
        "removedFingerprint"
      );
      return sendJson(response, 200, await mutate("removeChapterBreak", {
        storyId: id,
        breakId: subId,
        removedFingerprint
      }));
    }
    if (subId !== undefined && action === "restore" && method === "POST") {
      const removed = await jsonBody();
      return sendJson(response, 200, await mutate("restoreChapterBreak", {
        storyId: id,
        breakId: subId,
        removed
      }));
    }
    if (subId !== undefined && action === "summarize" && method === "POST") {
      await jsonBody();
      return sendJson(
        response,
        200,
        await mutate("summarizeChapter", {
          storyId: id,
          breakId: subId
        })
      );
    }
    if (subId !== undefined && action === "preview" && method === "GET") {
      return sendJson(
        response,
        200,
        await service.previewChapterBreakRemoval(id, subId)
      );
    }
  }
  if (head === "stories" && id !== undefined
    && sub === "unknown-outcomes" && subId !== undefined) {
    if (action === undefined && method === "GET") {
      return sendJson(
        response,
        200,
        await service.getUnknownOutcomeStatus(id, subId)
      );
    }
    if (action === "ack" && method === "POST") {
      await jsonBody();
      return sendJson(
        response,
        200,
        await mutate("acknowledgeUnknownOutcomes", {
          storyId: id,
          originalProviderMutationId: subId
        })
      );
    }
  }
  if (head === "stories" && id !== undefined && sub === "nodes" && subId !== undefined && action === "take-from-cut" && method === "POST") {
    return sendJson(response, 201, await mutate("takeFromCut", {
      storyId: id,
      nodeId: subId,
      body: await jsonBody()
    }));
  }
  if (head === "stories" && id !== undefined && sub === "nodes" && subId !== undefined && action === "rewrite" && method === "POST") {
    const body = await jsonBody();
    return await streamResponse(request, response,
      (onDelta, signal) => mutate(
        "rewriteNode",
        {
          storyId: id,
          nodeId: subId,
          body
        },
        onDelta,
        signal
      ),
      (nodeId) => ({ type: "done", nodeId }),
      operation.signal,
      context.errorReporter,
      "rewriteNode");
  }
  if (head === "stories" && id !== undefined && sub === "nodes" && subId === undefined && method === "POST") {
    return sendJson(response, 201, await mutate("createNode", {
      storyId: id,
      body: await jsonBody()
    }));
  }
  if (head === "stories" && id !== undefined && sub === "prune-unused-takes" && method === "POST") {
    return sendJson(response, 200, await mutate("pruneUnusedTakes", {
      storyId: id,
      body: await jsonBody()
    }));
  }
  if (head === "stories" && id !== undefined && sub === "nodes" && subId !== undefined && action === undefined) {
    if (method === "PATCH") {
      return sendJson(response, 200, await mutate("editNode", {
        storyId: id,
        nodeId: subId,
        body: await jsonBody()
      }));
    }
    if (method === "DELETE") {
      const expectedSubtreeCount = (await jsonBody()).expectedSubtreeCount;
      if (typeof expectedSubtreeCount !== "number") {
        throw new ServiceError(400, "expectedSubtreeCount must be an integer");
      }
      return sendJson(response, 200, await mutate("deleteNode", {
        storyId: id,
        nodeId: subId,
        expectedSubtreeCount
      }));
    }
  }
  if (head === "stories" && id !== undefined && sub === "tags"
    && subId !== undefined && action === undefined) {
    if (method === "PUT") {
      const body = await jsonBody();
      return sendJson(response, 200, await mutate("putBookmark", {
        storyId: id,
        nodeId: subId,
        name: requireString(body.name, "name"),
        // Request body says `status`; the durable mutation input keeps `label`.
        label: requireStringValue(
          body.status,
          "status"
        )
      }));
    }
    if (method === "DELETE") {
      return sendJson(response, 200, await mutate("deleteBookmark", {
        storyId: id,
        nodeId: subId
      }));
    }
  }
  if (head === "stories" && id !== undefined && sub === "facts" && action === undefined) {
    if (subId === undefined && method === "POST") {
      return sendJson(response, 201, await mutate("createFact", {
        storyId: id,
        body: await jsonBody()
      }));
    }
    if (subId !== undefined && method === "PATCH") {
      return sendJson(response, 200, await mutate("patchFact", {
        storyId: id,
        factId: subId,
        body: await jsonBody()
      }));
    }
    if (subId !== undefined && method === "DELETE") {
      return sendJson(response, 200, await mutate("deleteFact", {
        storyId: id,
        factId: subId
      }));
    }
  }
  if (head === "stories" && id !== undefined && sub === "facts"
    && subId !== undefined && action === "reorder" && method === "POST") {
    return sendJson(response, 200, await mutate("reorderFact", {
      storyId: id,
      factId: subId,
      body: await jsonBody()
    }));
  }
  if (head === "stories" && id !== undefined && sub === "import-lorebook" && method === "POST") {
    const rawBuffer = await readBufferBody(request, MAX_IMPORT_BYTES, operation.signal);
    return sendJson(
      response,
      200,
      await mutate("importLorebook", {
        storyId: id,
        archiveBytes: rawBuffer
      })
    );
  }

  if (head === "stories" && id !== undefined && sub === "autoname" && method === "POST") {
    const expectedTitle = requireStringValue(
      (await jsonBody()).expectedTitle,
      "expectedTitle"
    );
    return sendJson(
      response,
      200,
      await mutate("autonameStory", {
        id,
        expectedTitle
      })
    );
  }
  if (head === "stories" && id !== undefined && sub === "export" && method === "GET") {
    const exported = await service.exportStory(id);
    response.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exported.filename}"`
    });
    return void response.end(exported.markdown);
  }
  throw new ServiceError(404, `No route: ${method} ${pathname}`);
  };
  const mutation = operation.mutationId !== null;
  try {
    if (mutation && context.mutationGate !== undefined) {
      await context.mutationGate.run(route);
    } else {
      await route();
    }
    const settlement = await waitForResponseSettlement(response);
    operation.finish(
      settlement === "finished" ? "completed" : "canceled"
    );
  } catch (error) {
    operation.finish(operation.signal.aborted ? "canceled" : "failed");
    throw error;
  }
}

function requireCommandMutationId(
  command: Readonly<Record<string, unknown>>,
  reservedMutationId: string | null
): void {
  if (reservedMutationId === null
    || command.mutationId !== reservedMutationId) {
    throw new ServiceError(
      409,
      "Settings command mutation ID does not match its reservation",
      "invalid_request"
    );
  }
}
