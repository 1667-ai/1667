import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { AI_1667_BUILD_IDENTITY } from "../shared/build-identity.js";
import { WORKER_PROTOCOL_VERSION } from "../shared/worker-protocol.js";
import { encodeBridgeMessage } from "../shared/web-bridge-protocol.js";
import type * as Demo from "../client/demo.js";
import type * as Decoders from "../client/api-response-decoders.js";
import type * as Facade from "../client/worker-story-api.js";
import type * as WebBridge from "../client/web-bridge-transport.js";
import type * as WebBridgeConnect from "../client/web-bridge-connect.js";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("the shared client runs with browser globals only", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "1667-browser-client-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const entry = path.join(directory, "entry.ts");
  const bundle = path.join(directory, "browser.js");
  await writeFile(entry, [
    `import * as demo from ${JSON.stringify(path.join(root, "client/demo.ts"))};`,
    `import * as decoders from ${JSON.stringify(path.join(root, "client/api-response-decoders.ts"))};`,
    `import * as facade from ${JSON.stringify(path.join(root, "client/worker-story-api.ts"))};`,
    `import * as webBridge from ${JSON.stringify(path.join(root, "client/web-bridge-transport.ts"))};`,
    `import * as webBridgeConnect from ${JSON.stringify(path.join(root, "client/web-bridge-connect.ts"))};`,
    "globalThis.browserClient = { demo, decoders, facade, webBridge, webBridgeConnect };"
  ].join("\n"));
  await execFileAsync("bun", [
    "build", entry, "--target=browser", "--format=iife", `--outfile=${bundle}`
  ], { cwd: root, timeout: 60_000 });

  // Keep all five export surfaces in the bundle. No Node globals or module
  // loader are supplied: the renderer must own a real browser-only client.
  const browser = {
    TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, AbortSignal,
    structuredClone, setTimeout, clearTimeout, crypto: webcrypto,
    browserClient: undefined as {
      demo: typeof Demo;
      decoders: typeof Decoders;
      facade: typeof Facade;
      webBridge: typeof WebBridge;
      webBridgeConnect: typeof WebBridgeConnect;
    } | undefined
  };
  runInNewContext(await readFile(bundle, "utf8"), browser, { timeout: 10_000 });
  assert.ok(browser.browserClient);
  const { demo, decoders, facade, webBridge, webBridgeConnect } = browser.browserClient;
  const api = demo.demoStoryApi(demo.createDemoController());
  const stories = await api.listStories();
  assert.ok(stories.length > 0);
  const story = await api.loadStory(stories[0]!.id);
  assert.ok(story.path.length > 0);
  const settings = decoders.decodeSettingsViewResponse(await api.getSettings());
  assert.equal(settings.document?.schemaVersion, 5);
  const renamed = await api.renameStory(story.id, "Browser manuscript");
  assert.equal(renamed.title, "Browser manuscript");
  assert.ok(api.createFactState);
  assert.ok(api.patchFactState);
  const factId = story.facts[0]!.id;
  const text = "🌙".repeat(60_000);
  const withState = await api.createFactState(story.id, factId, {
    anchorPartId: story.path.at(-1)!.id, text
  });
  const state = withState.facts.find((fact) => fact.id === factId)!.states.at(-1)!;
  assert.equal("text" in state && state.text, text);
  await assert.rejects(
    api.patchFactState(story.id, factId, state.id, { text: "" }),
    /Fact text cannot be empty/
  );
  const aside = await api.askAside(
    story.id, "Who holds the lantern?", () => {}, new AbortController().signal
  );
  assert.ok(aside);
  assert.equal(typeof facade.storyApiFromWorkerTransport, "function");

  // client/web-bridge-transport.ts: a hello + request/accepted/result round
  // trip against a fake WebBridgeSocket, still inside the same browser-only
  // VM — the bundle must open a bridge transport with no DOM WebSocket, only
  // the structural subset `WebBridgeSocket` declares.
  const fake = createFakeBridgeSocket();
  const recoveryWarningsSeen: unknown[] = [];
  const opening = webBridge.openWebBridgeTransport(fake.socket, {
    onRecoveryWarnings: (warnings) => recoveryWarningsSeen.push(warnings)
  });
  fake.emit("message", {
    data: encodeBridgeMessage({
      type: "hello",
      workerProtocolVersion: WORKER_PROTOCOL_VERSION,
      build: AI_1667_BUILD_IDENTITY,
      recoveryWarnings: []
    })
  });
  const { transport: bridgeTransport, recoveryWarnings } = await opening;
  // The `hello` frame's own snapshot arrives on the resolved value, not the
  // `onRecoveryWarnings` callback — that fires only for a later frame, and
  // this connection never sends one.
  assert.equal(recoveryWarningsSeen.length, 0);
  // `recoveryWarnings` is an Array from the sandboxed realm: compare its
  // length rather than its identity or `assert.deepEqual` fails on the
  // cross-realm prototype mismatch alone.
  assert.equal(recoveryWarnings.length, 0);

  const operationId = { workerInstanceId: "a".repeat(32), sequence: 1n };
  const listing = bridgeTransport.call("listStories", {});
  assert.equal(fake.sent.length, 1);
  const sentRequest = JSON.parse(fake.sent[0]!) as { callId: string; method: string };
  assert.equal(sentRequest.method, "listStories");
  fake.emit("message", {
    data: encodeBridgeMessage({ type: "accepted", callId: sentRequest.callId, id: operationId })
  });
  fake.emit("message", {
    data: encodeBridgeMessage({ type: "result", id: operationId, value: [] })
  });
  assert.equal((await listing as readonly unknown[]).length, 0);

  // A throwing onDelta cancels the call but does not settle it: the host
  // may still commit, so the error is reported only with the terminal.
  const streamId = { workerInstanceId: "a".repeat(32), sequence: 2n };
  let deltaCalls = 0;
  let settled = false;
  const streaming = bridgeTransport.call("continueStory", {} as never, {
    onDelta: () => {
      deltaCalls += 1;
      throw new Error("page callback failed");
    }
  }).then(
    () => { settled = true; return null; },
    (error: unknown) => { settled = true; return error; }
  );
  const streamRequest = JSON.parse(fake.sent.at(-1)!) as { callId: string };
  fake.emit("message", {
    data: encodeBridgeMessage({ type: "accepted", callId: streamRequest.callId, id: streamId })
  });
  fake.emit("message", { data: encodeBridgeMessage({ type: "delta", id: streamId, sequence: 0, text: "a" }) });
  fake.emit("message", { data: encodeBridgeMessage({ type: "delta", id: streamId, sequence: 1, text: "b" }) });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(deltaCalls, 1);
  const sentTypes = fake.sent.map((frame) => (JSON.parse(frame) as { type: string }).type);
  assert.ok(sentTypes.includes("cancel"));
  fake.emit("message", {
    data: encodeBridgeMessage({ type: "complete", id: streamId, value: { committed: true } })
  });
  const streamFailure = await streaming;
  // The callback's Error comes from this realm, so the sandboxed transport
  // wraps it; only its text crosses intact.
  assert.match((streamFailure as Error).message, /page callback failed/);
  bridgeTransport.close();

  // client/web-bridge-connect.ts: the "no token anywhere" outcome, still
  // inside the same browser-only VM — proves `connectWebBridge` needs
  // nothing beyond its own parameters (plus the browser globals above,
  // now including `URLSearchParams`) to run this far. `fetch` and
  // `WebSocket` here throw if called at all: with no token, neither should be.
  const locked = await webBridgeConnect.connectWebBridge({
    location: { hash: "", host: "127.0.0.1:1", pathname: "/", search: "" },
    storage: { getItem: () => null, setItem: () => undefined },
    clearTokenFragment: () => undefined,
    fetch: (() => { throw new Error("fetch must not run with no token"); }) as unknown as typeof fetch,
    WebSocket: class {
      constructor() { throw new Error("WebSocket must not run with no token"); }
    } as unknown as new (url: string, protocols: string[]) => WebBridge.WebBridgeSocket
  });
  assert.equal(locked.kind, "locked");

  // A browser's fetch throws "Illegal invocation" when called with any
  // receiver other than the window; this fake enforces the same rule, and
  // a 401 answer ends the attempt before any WebSocket opens.
  const refused = await webBridgeConnect.connectWebBridge({
    location: { hash: `#token=${"a".repeat(64)}`, host: "127.0.0.1:1", pathname: "/", search: "" },
    storage: { getItem: () => null, setItem: () => undefined },
    clearTokenFragment: () => undefined,
    fetch: function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve({ status: 401, ok: false, json: async () => ({}) });
    } as unknown as typeof fetch,
    WebSocket: class {
      constructor() { throw new Error("WebSocket must not run after a 401"); }
    } as unknown as new (url: string, protocols: string[]) => WebBridge.WebBridgeSocket
  });
  assert.equal(refused.kind, "locked");
});

/** A minimal `WebBridgeSocket` driven by hand — no real network, no DOM. */
function createFakeBridgeSocket(): {
  readonly socket: WebBridge.WebBridgeSocket;
  readonly sent: string[];
  emit(type: "message" | "close", event: { readonly data?: unknown; readonly code?: number }): void;
} {
  type FakeListener = (event: { readonly data?: unknown; readonly code?: number }) => void;
  const listeners: Record<"message" | "close", FakeListener[]> = { message: [], close: [] };
  const sent: string[] = [];
  const socket: WebBridge.WebBridgeSocket = {
    send: (data) => sent.push(data),
    close: () => undefined,
    addEventListener: (type, listener) => {
      if (type === "message" || type === "close") {
        listeners[type].push(listener as unknown as FakeListener);
      }
    },
    removeEventListener: (type, listener) => {
      if (type === "message" || type === "close") {
        const target = listener as unknown as FakeListener;
        listeners[type] = listeners[type].filter((entry) => entry !== target);
      }
    }
  };
  return {
    socket,
    sent,
    emit: (type, event) => listeners[type].forEach((listener) => listener(event))
  };
}
