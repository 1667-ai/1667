import { splitSseEvents } from "../../shared/sse.js";
import { httpCapabilityScopeForApiPath } from "../../shared/http-capability-scope.js";
import { parseCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import type { HttpFetch } from "./direct-loopback-http.js";
import {
  decodeChapterBreakCreatedResponse,
  decodeChapterBreakRemovalPreview,
  decodeChapterBreakRemovedResponse,
  decodeContextWindowResponse,
  decodeDeleteStoryResponse,
  decodeStoryCatalogPageResponse,
  decodeUnknownOutcomeStatusResponse,
  decodeSettingsMutationResult,
  decodeSettingsViewResponse,
  decodeModelServerCheckResponse,
  decodeStoryResponse,
} from "./api-response-decoders.js";
import type { RemovedChapterBreak } from "./api-response-decoders.js";
import type {
  TagStatus,
  TagRequest,
  CreateFactsRequest,
  CreateNodeRequest,
  DeleteNodeRequest,
  GenerationSettings,
  ModelServerCheckResult,
  PruneUnusedTakesRequest,
  RewriteRequest,
  StoryNode,
  StoryPayload,
  StorySummary,
  SwitchRequest,
  TakeFromCutRequest
} from "../../shared/types.js";
import type {
  DiscardPendingSettingsCommand,
  ModelDiscoveryResultV2,
  ProviderProbeTarget,
  SaveSettingsCommand,
  SettingsMutationResult,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { decodeModelDiscoveryResult } from "../../shared/settings-response-decoder.js";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_SERVER_INSTANCE_HEADER,
  type HttpApiMetadata
} from "../../shared/http-protocol.js";
import {
  HttpOperationClient,
  HttpOperationError,
  type HttpListenerBinding,
  type HttpOperationRunOptions
} from "../../shared/http-operation-client.js";
import type {
  HttpListenerAuthority
} from "../../shared/http-listener-authority.js";
import {
  HTTP_OPERATION_LIFETIME_MS
} from "../../shared/http-operation-protocol.js";
import {
  WORKER_PROVIDER_CHECK_TIMEOUT_MS
} from "../../shared/worker-protocol.js";
import { isWorkerMutationMethod } from "../../shared/worker-protocol.js";
import { resolveHttpApiRoute } from "../../shared/http-operation-policy.js";
import type { StoryAggregateVersion } from "../../shared/story-aggregate-version.js";
import type { ProviderRecoveryContext } from "../../shared/provider-recovery.js";
import type { StoryCatalogPage } from "../../shared/story-catalog.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { HttpStoryVersions } from "./http-story-versions.js";
import {
  MemoryHttpMutationIntentStore,
  type HttpMutationIntentClaim,
  type HttpMutationIntentStore
} from "./http-mutation-intents.js";
import {
  ApiError,
  ApiHttpError,
  ApiRecoveryRequiredError,
  apiHttpErrorFromPayload
} from "./api-error.js";
import { HttpApiConnection } from "./http-api-connection.js";

export type { RemovedChapterBreak } from "./api-response-decoders.js";
export {
  ApiError,
  ApiHttpError,
  ApiRecoveryRequiredError,
  apiErrorCode
} from "./api-error.js";

const HTTP_REQUEST_TIMEOUT_MS = 15_000;
export const HTTP_GENERATION_REQUEST_TIMEOUT_MS =
  HTTP_OPERATION_LIFETIME_MS.generation;
export interface ContinueTarget {
  parentId?: string | null;
  appendTo?: string;
  expectedTextHash?: string;
}

/** Invariant relied on by the connection monitor's failure detection: any
 *  method that streams takes its AbortSignal as the LAST parameter. Keep new
 *  methods on that shape or teach connection.ts about the exception. */
export interface StoryApi {
  listStories(): Promise<StorySummary[]>;
  createStory(title?: string): Promise<StoryPayload>;
  loadStory(id: string): Promise<StoryPayload>;
  renameStory(id: string, title: string): Promise<StoryPayload>;
  autonameStory(id: string): Promise<StoryPayload>;
  acknowledgeUnknownOutcomes(
    storyId: string,
    originalProviderMutationId: string,
    providerRecovery?: ProviderRecoveryContext
  ): Promise<StoryPayload | null>;
  deleteStory(id: string): Promise<{ ok: true }>;
  exportMarkdown(id: string): Promise<string>;
  switchLine(storyId: string, nodeId: string, options?: Omit<SwitchRequest, "nodeId">): Promise<StoryPayload>;
  createNode(storyId: string, body: CreateNodeRequest): Promise<StoryPayload>;
  editNode(storyId: string, node: StoryNode, patch: { instruction?: string; text?: string }): Promise<StoryPayload>;
  deleteNode(storyId: string, nodeId: string, expectedSubtreeCount: number): Promise<StoryPayload>;
  pruneUnusedTakes(storyId: string, body: PruneUnusedTakesRequest): Promise<StoryPayload>;
  takeFromCut(storyId: string, nodeId: string, body: TakeFromCutRequest): Promise<StoryPayload>;
  putBookmark(storyId: string, nodeId: string, name: string, status: TagStatus): Promise<StoryPayload>;
  deleteBookmark(storyId: string, nodeId: string): Promise<StoryPayload>;
  createFact(storyId: string, body: CreateFactsRequest): Promise<StoryPayload>;
  patchFact(storyId: string, factId: string, body: { tag?: string | null; text?: string }): Promise<StoryPayload>;
  deleteFact(storyId: string, factId: string): Promise<StoryPayload>;
  createChapterBreak(storyId: string, parentPartId: string, title?: string): Promise<{ payload: StoryPayload; breakId: string }>;
  renameChapterBreak(storyId: string, breakId: string, title: string): Promise<StoryPayload>;
  removeChapterBreak(storyId: string, breakId: string): Promise<{ payload: StoryPayload; removed: RemovedChapterBreak }>;
  restoreChapterBreak(storyId: string, breakId: string, removed: RemovedChapterBreak): Promise<StoryPayload>;
  summarizeChapter(storyId: string, breakId: string): Promise<StoryPayload>;
  editChapterSummary(storyId: string, summaryId: string, text: string, expected: string): Promise<StoryPayload>;
  getSettings(): Promise<SettingsView>;
  saveSettings(command: SaveSettingsCommand): Promise<SettingsMutationResult>;
  discardPendingSettings(command: DiscardPendingSettingsCommand): Promise<SettingsMutationResult>;
  checkModelServer(settings: ProviderProbeTarget): Promise<ModelServerCheckResult>;
  probeContextWindow(settings: ProviderProbeTarget): Promise<{ contextWindow: number | null }>;
  discoverModels(
    settings: ProviderProbeTarget,
    signal?: AbortSignal
  ): Promise<ModelDiscoveryResultV2>;
  importSillyTavern(jsonl: string): Promise<StoryPayload>;
  continueStory(
    storyId: string,
    instruction: string,
    genId: string,
    target: ContinueTarget,
    onDelta: (text: string) => void,
    signal: AbortSignal
  ): Promise<StoryPayload | null>;
  rewriteNode(
    storyId: string,
    nodeId: string,
    body: RewriteRequest,
    onDelta: (text: string) => void,
    signal: AbortSignal
  ): Promise<void>;
  createSummaryTake(
    storyId: string,
    body: { nodeId: string; offset?: number; expected?: string },
    onDelta: (text: string) => void,
    signal: AbortSignal
  ): Promise<string | null>;
}

export interface HttpApiAccess {
  readonly authority: HttpListenerAuthority;
  readonly mutationIntents?: HttpMutationIntentStore;
}

export function createApi(
  baseUrl: string,
  onMetadata: ((metadata: HttpApiMetadata) => boolean | void) | undefined,
  access: HttpApiAccess
): StoryApi {
  const root = parseCanonicalLoopbackOrigin(baseUrl).origin;
  const mutationIntents = access.mutationIntents
    ?? new MemoryHttpMutationIntentStore();
  const url = (path: string) => `${root}${path}`;
  const versions = new HttpStoryVersions();
  const connection = new HttpApiConnection({
    root,
    authority: access.authority,
    ...(onMetadata === undefined ? {} : { onMetadata })
  });
  const operations = new HttpOperationClient({
    authority: access.authority,
    onSession: (_scope, payload) =>
      connection.publishRecoveryWarnings(payload.recoveryWarnings)
  });
  const runOperation = async <T>(
    options: HttpOperationRunOptions<T>
  ): Promise<T> => {
    try {
      return await operations.run(options);
    } catch (error) {
      if (error instanceof HttpOperationError) {
        throw new ApiHttpError(error.failure, false);
      }
      throw error;
    }
  };
  const compatible = async <T>(
    work: (binding: HttpListenerBinding) => Promise<T>,
    refresh = false,
    signal?: AbortSignal,
    mutation = false
  ): Promise<T> =>
    await connection.run(work, refresh, signal, mutation);
  const request = async <T>(
    method: string,
    path: string,
    decode: (payload: unknown) => T,
    body?: unknown,
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS,
    expectedAggregateVersion?: StoryAggregateVersion,
    callerSignal?: AbortSignal,
    mutationId?: string
  ): Promise<T> => {
    // A unary request retains the one backend-action owner until settlement,
    // so plain requests get a hard timeout. Local/control input remains live;
    // streaming calls keep their user-driven abort signal instead.
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal === undefined
      ? deadlineSignal
      : AbortSignal.any([callerSignal, deadlineSignal]);
    const mutation = isWorkerMutationMethod(
      resolveHttpApiRoute(method, path).method
    );
    return await compatible(async (binding) => {
      const entryRecoveryEpoch = connection.recoveryEpoch;
      return await runOperation({
        method,
        path,
        binding,
        ...(mutationId === undefined ? {} : { mutationId }),
        requestedLifetimeMs: timeoutMs,
        ...(expectedAggregateVersion === undefined
          ? {}
          : { expectedAggregateVersion }),
        callerSignal: signal,
        beforeSend: () => {
          if (mutation
            && connection.recoveryEpoch !== entryRecoveryEpoch) {
            throw new ApiRecoveryRequiredError();
          }
        },
        execute: async (lease) => {
          const response = await lease.fetch(url(path), {
            method,
            headers: {
              ...lease.headers,
              ...(body === undefined ? {} : { "content-type": "application/json" })
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: "error",
            signal: lease.signal
          });
          const payload: unknown = await response.json().catch(() => null);
          if (!response.ok) {
            throw apiHttpErrorFromPayload(
              payload,
              `${method} ${path} failed (${response.status})`,
              response.status
            );
          }
          return decode(payload);
        },
        shouldRetry: (error) => !(error instanceof ApiError)
      });
    }, true, signal, mutation);
  };
  const loadVersionedStory = async (
    storyId: string,
    callerSignal?: AbortSignal
  ): Promise<StoryPayload> =>
    versions.rememberPayload(await request(
      "GET",
      `/api/stories/${storyId}`,
      decodeStoryResponse,
      undefined,
      HTTP_REQUEST_TIMEOUT_MS,
      undefined,
      callerSignal
    ));
  const expectedVersion = async (
    storyId: string,
    callerSignal?: AbortSignal
  ): Promise<StoryAggregateVersion> => await versions.expected(
    storyId,
    () => loadVersionedStory(storyId, callerSignal)
  );
  const runProviderMutation = async <T>(
    storyId: string,
    work: () => Promise<T>
  ): Promise<T> => {
    try {
      const result = await work();
      if (result === null) versions.forget(storyId);
      return result;
    } catch (error) {
      // A terminal provider failure can advance the receipt-only story
      // revision without returning a payload that carries the new token.
      versions.forget(storyId);
      throw error;
    }
  };
  const stream = async (
    storyId: string,
    path: string,
    payload: unknown,
    onDelta: (text: string) => void,
    signal: AbortSignal
  ) => {
    if (signal.aborted) return null;
    try {
      return await runProviderMutation(storyId, async () => {
        const expectedAggregateVersion = await expectedVersion(
          storyId,
          signal
        );
        return await compatible(
          async (binding) => {
            const entryRecoveryEpoch = connection.recoveryEpoch;
            return await runOperation({
              method: "POST",
              path,
              binding,
              requestedLifetimeMs: HTTP_GENERATION_REQUEST_TIMEOUT_MS,
              expectedAggregateVersion,
              callerSignal: signal,
              beforeSend: () => {
                if (connection.recoveryEpoch !== entryRecoveryEpoch) {
                  throw new ApiRecoveryRequiredError();
                }
              },
              execute: async (lease) =>
                await streamSse(
                  lease.fetch,
                  url(path),
                  payload,
                  onDelta,
                  lease.signal,
                  signal,
                  lease.headers
                ),
              shouldRetry: (error) => !(error instanceof ApiError)
            });
          },
          true,
          signal,
          true
        );
      });
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    }
  };
  const mutateStoryPayload = async (
    storyId: string,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = HTTP_REQUEST_TIMEOUT_MS
  ): Promise<StoryPayload> => versions.rememberPayload(await request(
    method,
    path,
    decodeStoryResponse,
    body,
    timeoutMs,
    await expectedVersion(storyId)
  ));

  return {
    listStories: async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const held = new Map<string, StorySummary>();
        let scanId: string | null = null;
        let cursor: string | null = null;
        try {
          do {
            const page: StoryCatalogPage = await request(
              "POST",
              "/api/stories/catalog-page",
              decodeStoryCatalogPageResponse,
              { cursor, maxEntries: 64 }
            );
            if (scanId !== null && page.scanId !== scanId) {
              throw new Error(
                "The story catalog scan changed between pages."
              );
            }
            scanId = page.scanId;
            for (const summary of page.items) {
              const current = held.get(summary.id);
              if (current === undefined
                || summaryIsNewer(summary, current)) {
                held.set(summary.id, summary);
              }
            }
            cursor = page.cursor;
          } while (cursor !== null);
        } catch (error) {
          if (attempt === 0
            && error instanceof ApiHttpError
            && error.code === "catalog_cursor_expired") {
            continue;
          }
          throw error;
        }
        return versions.rememberSummaries(
          [...held.values()].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt))
        );
      }
      throw new Error("The story catalog retry was exhausted.");
    },
    createStory: async (title) => {
      const normalizedTitle = title?.trim() || "Untitled";
      const intent = await mutationIntents.claim(
        "createStory",
        normalizedTitle
      );
      try {
        const payload = await request(
          "POST",
          "/api/stories",
          decodeStoryResponse,
          { title: normalizedTitle },
          HTTP_REQUEST_TIMEOUT_MS,
          { kind: "absent" },
          undefined,
          intent.mutationId
        );
        await intent.complete();
        return versions.rememberPayload(payload);
      } catch (error) {
        return await settleAbsentMutationFailure(intent, error);
      }
    },
    loadStory: loadVersionedStory,
    renameStory: (id, title) => mutateStoryPayload(
      id,
      "PATCH",
      `/api/stories/${id}`,
      { title }
    ),
    autonameStory: async (id) => {
      return await runProviderMutation(id, async () => {
        const current = await loadVersionedStory(id);
        return await mutateStoryPayload(
          id,
          "POST",
          `/api/stories/${id}/autoname`,
          { expectedTitle: current.title },
          HTTP_GENERATION_REQUEST_TIMEOUT_MS
        );
      });
    },
    acknowledgeUnknownOutcomes: async (
      storyId,
      originalProviderMutationId
    ) => {
      const status = await request(
        "GET",
        `/api/stories/${storyId}/unknown-outcomes/${originalProviderMutationId}`,
        decodeUnknownOutcomeStatusResponse
      );
      if (status.state === "resolved") {
        if (status.deleted) {
          versions.forget(storyId);
          return null;
        }
        return await loadVersionedStory(storyId);
      }
      versions.set(storyId, status.aggregateVersion);
      const payload = await request(
        "POST",
        `/api/stories/${storyId}/unknown-outcomes/`
          + `${originalProviderMutationId}/ack`,
        (payload) => payload === null ? null : decodeStoryResponse(payload),
        {},
        HTTP_REQUEST_TIMEOUT_MS,
        status.aggregateVersion
      );
      if (payload === null) versions.forget(storyId);
      else versions.rememberPayload(payload);
      return payload;
    },
    deleteStory: async (id) => {
      const result = await request(
        "DELETE",
        `/api/stories/${id}`,
        decodeDeleteStoryResponse,
        undefined,
        HTTP_REQUEST_TIMEOUT_MS,
        await expectedVersion(id)
      );
      versions.forget(id);
      return result;
    },
    exportMarkdown: async (id) => compatible(
      async (binding) => {
        const path = `/api/stories/${id}/export`;
        const signal = AbortSignal.timeout(
          HTTP_OPERATION_LIFETIME_MS.transfer
        );
        return await runOperation({
          method: "GET",
          path,
          binding,
          requestedLifetimeMs: HTTP_OPERATION_LIFETIME_MS.transfer,
          callerSignal: signal,
          execute: async (lease) => {
            const response = await lease.fetch(url(path), {
              headers: lease.headers,
              redirect: "error",
              signal: lease.signal
            });
            const text = await response.text();
            if (!response.ok) {
              const payload = parseJson(text);
              throw apiHttpErrorFromPayload(
                payload,
                `GET /api/stories/${id}/export failed (${response.status})`,
                response.status
              );
            }
            return text;
          }
        });
      },
      true
    ),
    switchLine: (storyId, nodeId, options = {}) => mutateStoryPayload(
      storyId,
      "POST",
      `/api/stories/${storyId}/switch`,
      { nodeId, ...options } satisfies SwitchRequest
    ),
    createNode: (storyId, body) => mutateStoryPayload(
      storyId,
      "POST",
      `/api/stories/${storyId}/nodes`,
      body
    ),
    editNode: async (storyId, node, patch) => mutateStoryPayload(
      storyId,
      "PATCH",
      `/api/stories/${storyId}/nodes/${node.id}`,
      {
        ...patch,
        expectedTextHash: await textHash(node.text)
      }
    ),
    deleteNode: (storyId, nodeId, expectedSubtreeCount) =>
      mutateStoryPayload(
        storyId,
        "DELETE",
        `/api/stories/${storyId}/nodes/${nodeId}`,
        { expectedSubtreeCount } satisfies DeleteNodeRequest
      ),
    pruneUnusedTakes: (storyId, body) =>
      mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/prune-unused-takes`,
        body
      ),
    takeFromCut: (storyId, nodeId, body) =>
      mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/nodes/${nodeId}/take-from-cut`,
        body
      ),
    putBookmark: (storyId, nodeId, name, status) =>
      mutateStoryPayload(
        storyId,
        "PUT",
        `/api/stories/${storyId}/tags/${nodeId}`,
        { name, status } satisfies TagRequest
      ),
    deleteBookmark: (storyId, nodeId) => mutateStoryPayload(
      storyId,
      "DELETE",
      `/api/stories/${storyId}/tags/${nodeId}`
    ),
    createFact: (storyId, body) => mutateStoryPayload(
      storyId,
      "POST",
      `/api/stories/${storyId}/facts`,
      body
    ),
    patchFact: (storyId, factId, body) => mutateStoryPayload(
      storyId,
      "PATCH",
      `/api/stories/${storyId}/facts/${factId}`,
      body
    ),
    deleteFact: (storyId, factId) => mutateStoryPayload(
      storyId,
      "DELETE",
      `/api/stories/${storyId}/facts/${factId}`
    ),
    createChapterBreak: async (storyId, parentPartId, title = "") => {
      const result = await request(
        "POST",
        `/api/stories/${storyId}/chapter-breaks`,
        decodeChapterBreakCreatedResponse,
        { parentPartId, title },
        HTTP_REQUEST_TIMEOUT_MS,
        await expectedVersion(storyId)
      );
      versions.rememberPayload(result.payload);
      return result;
    },
    renameChapterBreak: (storyId, breakId, title) =>
      mutateStoryPayload(
        storyId,
        "PATCH",
        `/api/stories/${storyId}/chapter-breaks/${breakId}`,
        { title }
      ),
    removeChapterBreak: async (storyId, breakId) => {
      const preview = await request(
        "GET",
        `/api/stories/${storyId}/chapter-breaks/${breakId}/preview`,
        decodeChapterBreakRemovalPreview
      );
      const result = await request(
        "DELETE",
        `/api/stories/${storyId}/chapter-breaks/${breakId}`,
        decodeChapterBreakRemovedResponse,
        { removedFingerprint: preview.removedFingerprint },
        HTTP_REQUEST_TIMEOUT_MS,
        preview.aggregateVersion
      );
      versions.rememberPayload(result.payload);
      return result;
    },
    restoreChapterBreak: (storyId, breakId, removed) =>
      mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/chapter-breaks/${breakId}/restore`,
        removed
      ),
    summarizeChapter: (storyId, breakId) =>
      runProviderMutation(storyId, () => mutateStoryPayload(
        storyId,
        "POST",
        `/api/stories/${storyId}/chapter-breaks/${breakId}/summarize`,
        {},
        HTTP_GENERATION_REQUEST_TIMEOUT_MS
      )),
    editChapterSummary: async (storyId, summaryId, text, expected) =>
      mutateStoryPayload(
        storyId,
        "PATCH",
        `/api/stories/${storyId}/nodes/${summaryId}`,
        {
          text,
          expectedTextHash: await textHash(expected)
        }
      ),
    getSettings: () => request("GET", "/api/settings", decodeSettingsViewResponse),
    saveSettings: (command) => request(
      "PUT",
      "/api/settings",
      decodeSettingsMutationResult,
      command,
      HTTP_REQUEST_TIMEOUT_MS,
      undefined,
      undefined,
      command.mutationId
    ),
    discardPendingSettings: (command) =>
      request(
        "DELETE",
        "/api/settings/pending",
        decodeSettingsMutationResult,
        command,
        HTTP_REQUEST_TIMEOUT_MS,
        undefined,
        undefined,
        command.mutationId
      ),
    checkModelServer: (settings) => request("POST", "/api/settings/check-server", decodeModelServerCheckResponse, settings),
    probeContextWindow: (settings) => request(
      "POST",
      "/api/settings/probe-context",
      decodeContextWindowResponse,
      settings,
      WORKER_PROVIDER_CHECK_TIMEOUT_MS
    ),
    discoverModels: (settings, signal) => request(
      "POST",
      "/api/settings/discover-models",
      decodeModelDiscoveryResult,
      settings,
      WORKER_PROVIDER_CHECK_TIMEOUT_MS,
      undefined,
      signal
    ),
    importSillyTavern: async (jsonl) => {
      const intent = await mutationIntents.claim(
        "importSillyTavern",
        jsonl
      );
      try {
        const payload = await compatible(
          async (binding) => {
            const path = "/api/import/sillytavern";
            const signal = AbortSignal.timeout(
              HTTP_OPERATION_LIFETIME_MS.transfer
            );
            const entryRecoveryEpoch = connection.recoveryEpoch;
            return await runOperation({
              method: "POST",
              path,
              binding,
              mutationId: intent.mutationId,
              requestedLifetimeMs: HTTP_OPERATION_LIFETIME_MS.transfer,
              expectedAggregateVersion: { kind: "absent" },
              callerSignal: signal,
              beforeSend: () => {
                if (connection.recoveryEpoch !== entryRecoveryEpoch) {
                  throw new ApiRecoveryRequiredError();
                }
              },
              execute: async (lease) => {
                const response = await lease.fetch(url(path), {
                  method: "POST",
                  headers: {
                    ...lease.headers,
                    "content-type": "text/plain; charset=utf-8"
                  },
                  body: jsonl,
                  redirect: "error",
                  signal: lease.signal
                });
                const payload: unknown = await response.json().catch(() => null);
                if (!response.ok) {
                  throw apiHttpErrorFromPayload(
                    payload,
                    `Import failed (${response.status})`,
                    response.status
                  );
                }
                return versions.rememberPayload(decodeStoryResponse(payload));
              },
              shouldRetry: (error) => !(error instanceof ApiError)
            });
          },
          true,
          undefined,
          true
        );
        await intent.complete();
        return payload;
      } catch (error) {
        return await settleAbsentMutationFailure(intent, error);
      }
    },
    continueStory: async (storyId, instruction, genId, target, onDelta, signal) => {
      const done = await stream(
        storyId,
        `/api/stories/${storyId}/continue`,
        { instruction, genId, ...target },
        onDelta,
        signal
      );
      if (done === null) return null;
      return versions.rememberPayload(decodeStoryResponse(done.story));
    },
    rewriteNode: async (storyId, nodeId, body, onDelta, signal) => {
      await stream(
        storyId,
        `/api/stories/${storyId}/nodes/${nodeId}/rewrite`,
        body,
        onDelta,
        signal
      );
      await loadVersionedStory(storyId);
    },
    createSummaryTake: async (storyId, body, onDelta, signal) => {
      const done = await stream(
        storyId,
        `/api/stories/${storyId}/summary-take`,
        body,
        onDelta,
        signal
      );
      if (done === null) return null;
      if (typeof done.nodeId !== "string") throw new Error("The server did not return the new summary take.");
      await loadVersionedStory(storyId);
      return done.nodeId;
    }
  };
}

async function settleAbsentMutationFailure(
  intent: HttpMutationIntentClaim,
  error: unknown
): Promise<never> {
  try {
    if (intent.reused
      && (error instanceof ApiRecoveryRequiredError
        || (error instanceof ApiHttpError && !error.requestSent))) {
      await intent.retain();
    } else if (error instanceof ApiError) {
      await intent.complete();
    } else {
      await intent.retain();
    }
  } catch (settlementError) {
    throw new AggregateError(
      [error, settlementError],
      "HTTP mutation failure and intent settlement both failed",
      { cause: error }
    );
  }
  throw error;
}

function summaryIsNewer(
  candidate: StorySummary,
  current: StorySummary
): boolean {
  const candidateVersion = candidate.aggregateVersion;
  const currentVersion = current.aggregateVersion;
  if (candidateVersion?.kind === "v6"
    && currentVersion?.kind === "v6") {
    return candidateVersion.revision > currentVersion.revision;
  }
  return candidateVersion?.kind === "v6"
    && currentVersion?.kind !== "v6";
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

export async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function streamSse(
  transport: HttpFetch,
  endpoint: string,
  payload: unknown,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  callerSignal: AbortSignal,
  protocolHeaders: Readonly<Record<string, string>>
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await transport(endpoint, {
      method: "POST",
      headers: { ...protocolHeaders, "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal
    });
  } catch (error) {
    if (callerSignal.aborted) return null;
    if (signal.aborted) throw operationDeadlineError();
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!response.ok || response.body === null) {
    const errorPayload: unknown = await response.json().catch(() => null);
    throw apiHttpErrorFromPayload(
      errorPayload,
      `Request failed (${response.status})`,
      response.status
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: Record<string, unknown> | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const split = splitSseEvents(buffer);
      buffer = split.rest;
      for (const data of split.events) {
        const event = JSON.parse(data) as {
          type: string;
          text?: string;
          message?: string;
          code?: unknown;
          status?: unknown;
          diagnosticRef?: unknown;
        };
        if (event.type === "delta" && typeof event.text === "string") onDelta(event.text);
        if (event.type === "error") {
          throw apiHttpErrorFromPayload(
            event,
            "Generation failed.",
            event.status
          );
        }
        if (event.type === "done") completed = event as Record<string, unknown>;
      }
      if (completed !== null) {
        void reader.cancel().catch(() => undefined);
        return completed;
      }
    }
  } catch (error) {
    if (callerSignal.aborted) return null;
    if (signal.aborted) throw operationDeadlineError();
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (completed === null && callerSignal.aborted) return null;
  if (completed === null && signal.aborted) throw operationDeadlineError();
  if (completed === null) {
    throw new Error("The stream ended before the part was saved.");
  }
  return completed;
}

function operationDeadlineError(): ApiHttpError {
  return new ApiHttpError(createFailureEnvelope({
    code: "operation_expired",
    message:
      "Generation exceeded its operation deadline. Reload the story before retrying.",
    status: 408
  }));
}
