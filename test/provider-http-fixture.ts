import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT,
  writeInitialDataDirectoryFormat
} from "../server/data-directory-format.js";
import { ownedLoopbackHttpSupported } from "../server/provider-fetch.js";
import { formatGenerationSettingsV1 } from "../server/settings-v1-codec.js";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type {
  GenerationSettings,
  StoryPayload
} from "../shared/types.js";
import { createApi } from "../tui/src/api.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import {
  API_PROTOCOL_HEADERS,
  fetchWithApiProtocol,
  stopTestServerProcess,
  waitForTestServer
} from "./http-test-client.js";

const PROVIDER_TEST_TIMEOUT_MS = 30_000;

export function providerTest(
  name: string,
  body: (t: test.TestContext) => void | Promise<void>
): void {
  if (process.platform !== "linux" || !ownedLoopbackHttpSupported()) {
    test.skip(name, body);
    return;
  }
  test(name, { timeout: PROVIDER_TEST_TIMEOUT_MS }, body);
}

export async function fakeModel(
  t: test.TestContext,
  reply: (
    body: Record<string, unknown>,
    response: ServerResponse
  ) => void | Promise<void>
): Promise<{ baseUrl: string; requests: Record<string, unknown>[] }> {
  const requests: Record<string, unknown>[] = [];
  const handlerErrors: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url?.endsWith("/models") === true) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(
        await requestText(request)
      ) as Record<string, unknown>;
      requests.push(body);
      await reply(body, response);
    } catch (error) {
      handlerErrors.push(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  t.after(async () => {
    const closed = closeServer(server);
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await closeServerWithin(closed, server, sockets);
    if (handlerErrors.length > 0) {
      throw new AggregateError(
        handlerErrors,
        "Fake provider request handler failed"
      );
    }
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests
  };
}

export function stream(
  response: ServerResponse,
  chunks: readonly string[]
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const content of chunks) {
    response.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content }, finish_reason: null }]
      })}\n\n`
    );
  }
  response.end("data: [DONE]\n\n");
}

export function modelSettings(modelBaseUrl: string): GenerationSettings {
  return {
    provider: "openai-compatible",
    baseUrl: modelBaseUrl,
    model: "test-model",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Write coherent prose.",
    contextWindow: 4096
  };
}

export function doneStory(events: string): StoryPayload {
  for (const line of events.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice("data: ".length)) as {
      type?: unknown;
      story?: unknown;
    };
    if (event.type === "done") return event.story as StoryPayload;
  }
  assert.fail(`missing done story in ${events}`);
}

export function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      ...API_PROTOCOL_HEADERS,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithApiProtocol(url, init);
  if (!response.ok) {
    assert.fail(`${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

export async function getStory(
  base: string,
  id: string
): Promise<StoryPayload> {
  return await json(`${base}/api/stories/${id}`);
}

export async function seededStory(
  base: string,
  text: string
): Promise<StoryPayload> {
  const created = await json<StoryPayload>(
    `${base}/api/stories`,
    post({ title: "Test" })
  );
  return await json(
    `${base}/api/stories/${created.id}/nodes`,
    post({ parentId: null, instruction: "Write.", text })
  );
}

export async function testApp(
  t: test.TestContext,
  settings: GenerationSettings,
  temporaryPrefix: string
): Promise<string> {
  return await startTestApp(t, settings, temporaryPrefix, false);
}

/** Start a provider fixture whose story writes use the current data format. */
export async function currentDataFormatTestApp(
  t: test.TestContext,
  settings: GenerationSettings,
  temporaryPrefix: string
): Promise<string> {
  return await startTestApp(t, settings, temporaryPrefix, true);
}

async function startTestApp(
  t: test.TestContext,
  settings: GenerationSettings,
  temporaryPrefix: string,
  currentDataFormat: boolean
): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), temporaryPrefix));
  if (currentDataFormat) {
    await writeInitialDataDirectoryFormat(dataDir, 2);
  } else {
    await writeFile(
      path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER),
      LEGACY_PREVIEW_DATA_MARKER_TEXT,
      { mode: 0o600 }
    );
    await writeFile(
      path.join(dataDir, "settings.json"),
      formatGenerationSettingsV1(settings),
      { encoding: "utf8", mode: 0o600, flag: "wx" }
    );
  }
  const port = await availablePort();
  const server = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--print-logs"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        AI_1667_DATA: dataDir,
        AI_1667_PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  server.stdout?.on("data", (chunk) => { output += String(chunk); });
  server.stderr?.on("data", (chunk) => { output += String(chunk); });
  t.after(async () => {
    await stopTestServerProcess(server);
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForTestServer(server, base, () => output);
  if (currentDataFormat) await saveFixtureSettings(t, base, settings);
  return base;
}

async function saveFixtureSettings(
  t: test.TestContext,
  base: string,
  settings: GenerationSettings
): Promise<void> {
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);
  const view = await api.getSettings();
  assert.equal(view.dataFormat, 2);
  if (!view.editable) assert.fail("current provider fixture settings are not editable");
  const mutationId = createDurableMutationId();
  const result = await api.saveSettings({
    transportOperationId: `fixture:${mutationId}`,
    mutationId,
    expectedStateGeneration: view.stateGeneration,
    document: applyBasicSettingsDraft(view.document, settings)
  });
  assert.equal(result.pendingSettingsRevision, null);
  const saved = await api.getSettings();
  assert.deepEqual(saved.effective, settings);
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) =>
    probe.listen(0, "127.0.0.1", resolve)
  );
  const port = (probe.address() as AddressInfo).port;
  await closeServer(probe);
  return port;
}

async function closeServer(
  server: ReturnType<typeof createServer>
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error))
  );
}

async function closeServerWithin(
  closed: Promise<void>,
  server: ReturnType<typeof createServer>,
  sockets: ReadonlySet<Socket>
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      reject(new Error("Fake provider server did not close within 1 second"));
    }, 1_000);
  });
  try {
    await Promise.race([closed, bounded]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function requestText(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text;
}
