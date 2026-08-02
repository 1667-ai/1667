import type { ChildProcess } from "node:child_process";
import {
  HTTP_API_PROTOCOL_VERSION,
  HTTP_CLIENT_PROTOCOL_HEADER,
  HTTP_SERVER_INSTANCE_HEADER
} from "../shared/http-protocol.js";
import { bearerAuthorization, HTTP_AUTHORIZATION_HEADER } from "../shared/http-auth.js";
import { readHttpAuthRecord } from "../server/http-auth-record.js";
import {
  HttpOperationClient,
  type HttpOperationLease
} from "../shared/http-operation-client.js";
import {
  HttpListenerAuthority,
  type HttpListenerBinding
} from "../shared/http-listener-authority.js";
import { resolveHttpApiRoute } from "../shared/http-operation-policy.js";
import {
  parseStoryAggregateVersion,
  type StoryAggregateVersion
} from "../shared/story-aggregate-version.js";
import { isWorkerMutationMethod } from "../shared/worker-protocol.js";
import { platformPerformanceBudget } from "./performance-budget.js";

export const API_PROTOCOL_HEADERS: Record<string, string> = {
  [HTTP_CLIENT_PROTOCOL_HEADER]: String(HTTP_API_PROTOCOL_VERSION)
};
// Windows Defender can scan each cold native-helper process, which the owned
// platform scale already covers. The direct adapter contract keeps its
// independent 10-second production ceiling.
const SERVER_START_BUDGET_MS = platformPerformanceBudget(10_000);
const SERVER_STOP_BUDGET_MS = platformPerformanceBudget(1_000);
let operationClient: HttpOperationClient | null = null;
let operationBinding: HttpListenerBinding | null = null;
let lastReservedMutationId: string | null = null;

export function lastTestMutationId(): string | null {
  return lastReservedMutationId;
}

export async function waitForTestServer(
  server: {
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
  },
  origin: string,
  output: () => string
): Promise<void> {
  const deadline = Date.now() + SERVER_START_BUDGET_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`server exited: ${output()}`);
    }
    try {
      const { record } = await readHttpAuthRecord(origin);
      const response = await fetch(`${origin}/api/health`, {
        headers: {
          [HTTP_AUTHORIZATION_HEADER]:
            bearerAuthorization(record.capabilities.story),
          [HTTP_CLIENT_PROTOCOL_HEADER]:
            String(HTTP_API_PROTOCOL_VERSION),
          [HTTP_SERVER_INSTANCE_HEADER]: record.instanceId
        }
      });
      if (response.ok) {
        await rememberServerInstance(await response.json(), origin);
        return;
      }
    } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `server did not start within ${SERVER_START_BUDGET_MS / 1_000} seconds: ${output()}`
  );
}

export async function stopTestServerProcess(
  server: ChildProcess
): Promise<void> {
  operationClient?.dispose();
  operationClient = null;
  delete API_PROTOCOL_HEADERS[HTTP_SERVER_INSTANCE_HEADER];
  delete API_PROTOCOL_HEADERS[HTTP_AUTHORIZATION_HEADER];
  if (server.exitCode !== null || server.signalCode !== null) {
    closeTestServerPipes(server);
    return;
  }
  const closed = new Promise<void>((resolve) =>
    server.once("close", () => resolve())
  );
  server.kill("SIGTERM");
  if (await settlesWithin(closed, SERVER_STOP_BUDGET_MS)) return;
  const killed = server.kill("SIGKILL");
  if (await settlesWithin(closed, SERVER_STOP_BUDGET_MS)) return;
  closeTestServerPipes(server);
  throw new Error(
    killed
      ? `Test server did not close within ${SERVER_STOP_BUDGET_MS}ms after SIGKILL`
      : "Test server could not be sent SIGKILL and did not close"
  );
}

async function settlesWithin(
  settled: Promise<void>,
  milliseconds: number
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function closeTestServerPipes(server: ChildProcess): void {
  server.stdout?.destroy();
  server.stderr?.destroy();
}

export async function rememberServerInstance(metadata: unknown, origin: string): Promise<void> {
  const serverInstanceId = metadata !== null && typeof metadata === "object"
    ? (metadata as { serverInstanceId?: unknown }).serverInstanceId
    : undefined;
  if (typeof serverInstanceId !== "string" || serverInstanceId.length === 0) {
    throw new Error("Test server returned no instance ID");
  }
  API_PROTOCOL_HEADERS[HTTP_SERVER_INSTANCE_HEADER] = serverInstanceId;
  const { record } = await readHttpAuthRecord(origin);
  if (record.instanceId !== serverInstanceId) {
    throw new Error("Test auth record does not match the server instance");
  }
  API_PROTOCOL_HEADERS[HTTP_AUTHORIZATION_HEADER] =
    bearerAuthorization(record.capabilities.story);
  operationClient?.dispose();
  operationBinding = { authRecord: record, fetch };
  operationClient = new HttpOperationClient({
    authority: new HttpListenerAuthority({
      root: origin,
      binding: operationBinding
    })
  });
}

export function withApiProtocol(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set(HTTP_CLIENT_PROTOCOL_HEADER, String(HTTP_API_PROTOCOL_VERSION));
  const serverInstanceId = API_PROTOCOL_HEADERS[HTTP_SERVER_INSTANCE_HEADER];
  if (serverInstanceId !== undefined) headers.set(HTTP_SERVER_INSTANCE_HEADER, serverInstanceId);
  const authorization = API_PROTOCOL_HEADERS[HTTP_AUTHORIZATION_HEADER];
  if (authorization !== undefined) headers.set(HTTP_AUTHORIZATION_HEADER, authorization);
  return { ...init, headers };
}

export async function fetchWithApiProtocol(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  return await fetchWithApiProtocolAtVersion(url, init);
}

export async function fetchWithApiProtocolAtVersion(
  url: string,
  init: RequestInit,
  expectedVersion?: StoryAggregateVersion
): Promise<Response> {
  const prepared = await prepareChapterRemoval(url, init);
  if (prepared instanceof Response) return prepared;
  init = prepared;
  if (operationClient === null || operationBinding === null) {
    throw new Error("rememberServerInstance must run before API requests");
  }
  const serverInstanceId = API_PROTOCOL_HEADERS[HTTP_SERVER_INSTANCE_HEADER];
  if (serverInstanceId === undefined) {
    throw new Error("Test server instance is unavailable");
  }
  const path = new URL(url).pathname;
  const method = (init.method ?? "GET").toUpperCase();
  const expectedAggregateVersion = expectedVersion
    ?? await expectedStoryVersion(
      url,
      method,
      path,
      init.signal ?? undefined
    );
  const lease = await operationClient.reserve({
    method,
    path,
    binding: operationBinding,
    ...(init.signal === null || init.signal === undefined
      ? {}
      : { callerSignal: init.signal }),
    ...(expectedAggregateVersion === undefined
      ? {}
      : { expectedAggregateVersion })
  });
  lastReservedMutationId = lease.mutationId;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(lease.headers)) {
    headers.set(name, value);
  }
  const response = await fetch(url, {
    ...init,
    headers,
    signal: lease.signal
  });
  return wrapResponse(response, lease);
}

async function expectedStoryVersion(
  url: string,
  method: string,
  path: string,
  signal: AbortSignal | undefined
): Promise<StoryAggregateVersion | undefined> {
  const policy = resolveHttpApiRoute(method, path);
  if (policy.scope !== "story" || !isWorkerMutationMethod(policy.method)) {
    return undefined;
  }
  if (policy.method === "createStory"
    || policy.method === "importSillyTavern"
    || policy.method === "importMarkdown"
    || policy.method === "importNovelAI"
    || policy.method === "importScenario") {
    return { kind: "absent" };
  }
  const storyId = path.split("/")[3];
  if (storyId === undefined || storyId.length === 0) {
    throw new Error(`Cannot resolve the story mutation target for ${method} ${path}`);
  }
  const loaded = await fetchWithApiProtocol(
    `${new URL(url).origin}/api/stories/${storyId}`,
    { signal }
  );
  const payload: unknown = await loaded.json();
  if (!loaded.ok || payload === null || typeof payload !== "object") {
    throw new Error(`Cannot load the story mutation version for ${method} ${path}`);
  }
  return parseStoryAggregateVersion(
    (payload as { aggregateVersion?: unknown }).aggregateVersion,
    "story payload.aggregateVersion"
  );
}

async function prepareChapterRemoval(
  url: string,
  init: RequestInit
): Promise<RequestInit | Response> {
  const path = new URL(url).pathname;
  if ((init.method ?? "GET").toUpperCase() !== "DELETE"
    || init.body !== undefined
    || !/^\/api\/stories\/[^/]+\/chapter-breaks\/[^/]+$/.test(path)) {
    return init;
  }
  const preview = await fetchWithApiProtocol(`${url}/preview`);
  if (!preview.ok) return preview;
  const payload: unknown = await preview.json();
  const fingerprint = payload !== null && typeof payload === "object"
    ? (payload as { removedFingerprint?: unknown }).removedFingerprint
    : undefined;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("Chapter-removal preview returned an invalid fingerprint");
  }
  return {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      "content-type": "application/json"
    },
    body: JSON.stringify({ removedFingerprint: fingerprint })
  };
}

function wrapResponse(response: Response, lease: HttpOperationLease): Response {
  if (response.body === null) {
    void lease.settle();
    return response;
  }
  const reader = response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await lease.settle();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await lease.settle();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await lease.settle();
    }
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
