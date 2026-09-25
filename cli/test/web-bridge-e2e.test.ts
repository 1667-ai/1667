import { afterEach, expect, test } from "bun:test";
import {
  cleanupWebProcesses,
  scratchProject,
  spawnWeb,
  spawnWebRaw,
  type ReadyWeb
} from "./web-e2e-fixture.js";
import {
  openWebBridgeTransport,
  webBridgeProtocols,
  webBridgeUrl,
  WebBridgeTransport
} from "../../client/web-bridge-transport.js";
import { storyApiFromWorkerTransport } from "../../client/worker-story-api.js";
import {
  WEB_BRIDGE_SUBPROTOCOL,
  WEB_BRIDGE_TOKEN_PREFIX
} from "../../shared/web-bridge-protocol.js";

/**
 * `1667 web`'s WebSocket bridge (#409 step 2): the browser's full `StoryApi`
 * over the embedded Worker `1667 web` already holds. These tests spawn the
 * real CLI (`web-e2e-fixture.ts`) and drive `openWebBridgeTransport` with a
 * real `WebSocket` — an external client, matching CLAUDE.md's preference for
 * an end-to-end test over one that pokes at internal structure.
 */

afterEach(cleanupWebProcesses);

/** Bun's `WebSocket` accepts `{ protocols, headers }` as its second
 * constructor argument (verified against Bun 1.3.14); the DOM lib type only
 * declares `string | string[]`, so this is the one place that gap is bridged. */
type BunWebSocketConstructor = new (
  url: string,
  init?: {
    readonly protocols?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
  }
) => WebSocket;
const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

function openSocket(
  web: ReadyWeb,
  options: {
    readonly protocols?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
    readonly path?: string;
  } = {}
): WebSocket {
  const base = webBridgeUrl({ host: `127.0.0.1:${web.port}` });
  const url = options.path === undefined ? base : `ws://127.0.0.1:${web.port}${options.path}`;
  return new BunWebSocket(url, {
    protocols: options.protocols ?? webBridgeProtocols(web.token),
    headers: options.headers ?? { origin: web.origin }
  });
}

async function openBridge(web: ReadyWeb): Promise<WebBridgeTransport> {
  return (await openWebBridgeTransport(openSocket(web))).transport;
}

/** Also hands back the raw socket, for a test that needs to close the
 * connection itself (rather than through `WebBridgeTransport.close`, whose
 * own reason text differs — see the "1667 web connection closed" tests). */
async function openBridgeWithSocket(
  web: ReadyWeb
): Promise<{ readonly socket: WebSocket; readonly transport: WebBridgeTransport }> {
  const socket = openSocket(web);
  const { transport } = await openWebBridgeTransport(socket);
  return { socket, transport };
}

/** The `bun:test` `expect` stub this repo typechecks against (see
 * `tui/src/bun-test.d.ts`) has no `.rejects` — this is the established
 * idiom elsewhere in `cli/test` (e.g. `card-import-cli.test.ts`) for
 * asserting a promise rejects, and what its message says. */
async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "the call resolved instead of failing";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** A cancelled mutation keeps its story's mutation-coordinator scope claimed
 * until server-side cancellation fully settles (`server/mutation-coordinator.ts`),
 * which is not instant. A connection that closed mid-mutation therefore does
 * not guarantee the *next* mutation on that same story admits immediately —
 * only that it eventually does, once that scope releases. */
async function retryOnBusy<T>(run: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const busy = error instanceof Error && error.message.includes("Mutation capacity is busy");
      if (!busy || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A connection attempt the server must refuse before any application data
 * flows: no HTTP status can be written mid-upgrade, so the server only
 * `socket.destroy()`s, which the client sees as an `error` event, a `close`
 * with code 1006, or both — never an `open`. */
async function expectRefused(socket: WebSocket): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("refused connection neither closed nor errored in time")),
        10_000
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        reject(new Error("connection unexpectedly opened"));
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}

test("list, create, load, and list again round-trip over the bridge", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const transport = await openBridge(web);
  try {
    const api = storyApiFromWorkerTransport(transport);
    const before = await api.listStories();
    const created = await api.createStory("Bridge round trip");
    const loaded = await api.loadStory(created.id);
    expect(loaded.id).toBe(created.id);
    const after = await api.listStories();
    expect(after.length).toBe(before.length + 1);
    expect(after.some((summary) => summary.id === created.id)).toBeTrue();
  } finally {
    transport.close();
  }
}, 30_000);

test("importCard's cardBytes (a binary field) round-trips over the bridge", async () => {
  // The same plain-JSON V2 card fixture `cli/test/card-import-cli.test.ts`
  // uses — `importCard` accepts a card's raw file bytes, JSON or not, so
  // this needs no PNG or other native-image tooling to stay portable.
  const cardBytes = new TextEncoder().encode(JSON.stringify({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Mira",
      description: "A cartographer.",
      personality: "Exacting but kind.",
      scenario: ""
    }
  }));
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const transport = await openBridge(web);
  try {
    const api = storyApiFromWorkerTransport(transport);
    const story = await api.createStory("Bridge binary import");
    const { payload, plan } = await api.importCard(story.id, cardBytes);
    expect(plan.name).toBe("Mira");
    expect(payload.facts.some((fact) => fact.tag === "Character")).toBeTrue();
  } finally {
    transport.close();
  }
}, 30_000);

test("continueStory streams at least one delta and resolves; loadStory sees the new text", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const transport = await openBridge(web);
  try {
    const api = storyApiFromWorkerTransport(transport);
    const story = await api.createStory("Bridge continue");
    const seeded = await api.createNode(story.id, { parentId: null, text: "Once upon a time" });
    const parentId = seeded.path.at(-1)?.id;
    if (parentId === undefined) throw new Error("seed produced no parent node");
    const deltas: string[] = [];
    const result = await api.continueStory(
      story.id,
      "continue",
      "bridge-continue",
      { parentId },
      (text) => deltas.push(text),
      new AbortController().signal
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(result).not.toBeNull();
    const loaded = await api.loadStory(story.id);
    expect(loaded.path.length).toBeGreaterThan(seeded.path.length);
  } finally {
    transport.close();
  }
}, 30_000);

test("aborting after the first delta settles null; a new continue then completes", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const transport = await openBridge(web);
  try {
    const api = storyApiFromWorkerTransport(transport);
    const story = await api.createStory("Bridge abort");
    const seeded = await api.createNode(story.id, { parentId: null, text: "Once upon a time" });
    const parentId = seeded.path.at(-1)?.id;
    if (parentId === undefined) throw new Error("seed produced no parent node");

    const controller = new AbortController();
    const firstDeltas: string[] = [];
    const aborted = await api.continueStory(
      story.id,
      "continue",
      "bridge-abort-1",
      { parentId },
      (text) => {
        firstDeltas.push(text);
        if (firstDeltas.length === 1) controller.abort();
      },
      controller.signal
    );
    expect(aborted).toBeNull();

    const secondDeltas: string[] = [];
    const completed = await api.continueStory(
      story.id,
      "continue",
      "bridge-abort-2",
      { parentId },
      (text) => secondDeltas.push(text),
      new AbortController().signal
    );
    expect(completed).not.toBeNull();
    expect(secondDeltas.length).toBeGreaterThan(0);
  } finally {
    transport.close();
  }
}, 30_000);

test("closing the socket after the first delta rejects the pending call; "
  + "a new connection can rename and continue the same story", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const { socket: firstSocket, transport: first } = await openBridgeWithSocket(web);
  const firstApi = storyApiFromWorkerTransport(first);
  const story = await firstApi.createStory("Bridge close");
  const seeded = await firstApi.createNode(story.id, { parentId: null, text: "Once upon a time" });
  const parentId = seeded.path.at(-1)?.id;
  if (parentId === undefined) throw new Error("seed produced no parent node");

  const deltas: string[] = [];
  const pending = firstApi.continueStory(
    story.id,
    "continue",
    "bridge-close-1",
    { parentId },
    (text) => {
      deltas.push(text);
      // Close the raw socket itself, not `first.close()`: the transport's
      // own `.close()` rejects with a generic reason instantly, before any
      // real socket event — this proves the *socket*-close path instead.
      if (deltas.length === 1) firstSocket.close();
    },
    new AbortController().signal
  );
  const rejection = await failure(() => pending);
  expect(rejection).toContain("1667 web connection closed");

  const second = await openBridge(web);
  try {
    const secondApi = storyApiFromWorkerTransport(second);
    const renamed = await retryOnBusy(() => secondApi.renameStory(story.id, "Bridge close (renamed)"));
    expect(renamed.title).toBe("Bridge close (renamed)");
    const moreDeltas: string[] = [];
    const completed = await retryOnBusy(() => secondApi.continueStory(
      story.id,
      "continue",
      "bridge-close-2",
      { parentId },
      (text) => moreDeltas.push(text),
      new AbortController().signal
    ));
    expect(completed).not.toBeNull();
    expect(moreDeltas.length).toBeGreaterThan(0);
  } finally {
    second.close();
  }
}, 30_000);

test("a raw connection that never acks gets exactly 8 deltas, then a terminal, and no more", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const setup = await openBridge(web);
  let storyId: string;
  let parentId: string;
  let aggregateVersion: unknown;
  try {
    const api = storyApiFromWorkerTransport(setup);
    const story = await api.createStory("Bridge credit window");
    const seeded = await api.createNode(story.id, { parentId: null, text: "Once upon a time" });
    const seededParentId = seeded.path.at(-1)?.id;
    if (seededParentId === undefined) throw new Error("seed produced no parent node");
    storyId = seeded.id;
    parentId = seededParentId;
    aggregateVersion = seeded.aggregateVersion;
  } finally {
    setup.close();
  }

  const raw = openSocket(web);
  try {
    const messages: { readonly type: string }[] = [];
    raw.addEventListener("message", (event) => {
      messages.push(JSON.parse(String((event as MessageEvent).data)) as { type: string });
    });
    await new Promise<void>((resolve, reject) => {
      raw.addEventListener("open", () => resolve());
      raw.addEventListener("error", () => reject(new Error("raw connection failed to open")));
    });
    await waitFor(() => messages.some((message) => message.type === "hello"));
    raw.send(JSON.stringify({
      type: "request",
      callId: "raw-credit",
      method: "continueStory",
      input: {
        storyId,
        instruction: "credit window",
        genId: "bridge-credit",
        target: { parentId }
      },
      expectedAggregateVersion: aggregateVersion
      // Deliberately never sends "ack": the credit window is the only thing
      // that can ever stop this stream's deltas.
    }));
    await waitFor(
      () => messages.filter((message) => message.type === "delta").length >= 8,
      20_000
    );
    const deltaCount = messages.filter((message) => message.type === "delta").length;
    expect(deltaCount).toBe(8);
    await waitFor(
      () => messages.some((message) => message.type === "complete" || message.type === "error"),
      20_000
    );
    expect(messages.filter((message) => message.type === "delta").length).toBe(deltaCount);
  } finally {
    raw.close();
  }
}, 30_000);

test("two connections at once: closing one mid-stream does not disturb the other's stream", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const { socket: socketA, transport: transportA } = await openBridgeWithSocket(web);
  const transportB = await openBridge(web);
  try {
    const apiA = storyApiFromWorkerTransport(transportA);
    const apiB = storyApiFromWorkerTransport(transportB);
    const storyA = await apiA.createStory("Bridge connection A");
    const seededA = await apiA.createNode(storyA.id, { parentId: null, text: "seed a" });
    const parentIdA = seededA.path.at(-1)?.id;
    const storyB = await apiB.createStory("Bridge connection B");
    const seededB = await apiB.createNode(storyB.id, { parentId: null, text: "seed b" });
    const parentIdB = seededB.path.at(-1)?.id;
    if (parentIdA === undefined || parentIdB === undefined) {
      throw new Error("seed produced no parent node");
    }

    const deltasB: string[] = [];
    const runningB = apiB.continueStory(
      storyB.id,
      "continue",
      "bridge-two-b",
      { parentId: parentIdB },
      (text) => deltasB.push(text),
      new AbortController().signal
    );
    let closedA = false;
    const runningA = apiA.continueStory(
      storyA.id,
      "continue",
      "bridge-two-a",
      { parentId: parentIdA },
      () => {
        // Close the raw socket itself — see the "closing the socket" test's
        // comment on why `transportA.close()` would produce the wrong reason.
        if (!closedA) {
          closedA = true;
          socketA.close();
        }
      },
      new AbortController().signal
    );

    const [rejectionA, resultB] = await Promise.all([failure(() => runningA), runningB]);
    expect(rejectionA).toContain("1667 web connection closed");
    expect(resultB).not.toBeNull();
    expect(deltasB.length).toBeGreaterThan(0);
  } finally {
    transportA.close();
    transportB.close();
  }
}, 30_000);

test("the bridge refuses a wrong token, no token protocol, a missing bridge protocol, "
  + "a foreign Origin, no Origin, a wrong Host, and a wrong path", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  const goodOrigin = { origin: web.origin };

  await expectRefused(openSocket(web, {
    protocols: webBridgeProtocols("0".repeat(64)),
    headers: goodOrigin
  }));
  await expectRefused(openSocket(web, {
    protocols: [WEB_BRIDGE_SUBPROTOCOL],
    headers: goodOrigin
  }));
  await expectRefused(openSocket(web, {
    protocols: [`${WEB_BRIDGE_TOKEN_PREFIX}${web.token}`],
    headers: goodOrigin
  }));
  await expectRefused(openSocket(web, { headers: { origin: "http://evil.example" } }));
  await expectRefused(openSocket(web, { headers: {} }));
  await expectRefused(openSocket(web, { headers: { ...goodOrigin, host: "evil.example:1" } }));
  await expectRefused(openSocket(web, { path: "/not-the-bridge" }));
}, 30_000);

test("a second `1667 web` fails with the existing lock message while a bridge is connected; "
  + "SIGINT closes the open socket 1001, exits 0, and a new instance can start", async () => {
  const project = await scratchProject();
  const web = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
  // Boxed rather than a bare `let`: TypeScript otherwise keeps narrowing this
  // variable to its initial `null` across the `onClose` closure's reassignment.
  const closeState: { error: Error | null } = { error: null };
  const { transport } = await openWebBridgeTransport(openSocket(web), {
    onClose: (error) => { closeState.error = error; }
  });
  try {
    const second = spawnWebRaw(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
    const result = await second.exit;
    expect(result.code).not.toBe(0);
    expect(second.stderrText()).toContain("already open by");

    web.child.kill("SIGINT");
    const exit = await web.exit;
    expect(exit.code).toBe(0);
    expect(exit.signal).toBe(null);

    await waitFor(() => closeState.error !== null);
    // Bun's builtin `ws` module does not deliver a server-requested non-1000
    // close code to the client (verified against Bun 1.3.14: a server-side
    // `ws.close(1001, reason)` always arrives as code 1000) — the reason
    // text is what actually distinguishes a graceful stop here.
    expect((closeState.error as Error).message).toContain("1667 web connection closed");

    const third = await spawnWeb(["--data", project.dataDir, "--port", "0", "--no-open"], project.env);
    expect(third.url).toContain("http://127.0.0.1:");
  } finally {
    transport.close();
  }
}, 30_000);
