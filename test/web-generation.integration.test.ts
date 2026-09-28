import assert from "node:assert/strict";
import test from "node:test";
import { textHash } from "../client/api.js";
import { ApiFailureError } from "../client/api-error.js";
import type { ContinueTarget, StoryApi, StreamCallbacks } from "../client/api.js";
import { WebBridgeTransportError, type WebBridgeTransport } from "../client/web-bridge-transport.js";
import { DEFAULT_INSTRUCTION } from "../shared/continuation-plan.js";
import type { CreateNodeRequest, NodeStub, StoryPathNode, StoryPayload } from "../shared/types.js";
import { createGenerationActions, type GenerationActions } from "../web/src/generation/actions.js";
import { createManualFlushScheduler, type ManualFlushScheduler } from "../web/src/generation/stream-buffer.js";
import { generationLocks, manuscriptGenerationView } from "../web/src/generation/state.js";
import { createStoryActions, STORY_LOCKED_TOAST, type StoryActions } from "../web/src/story/actions.js";
import type { ConnectionState } from "../web/src/app/connection.js";
import { initialAppState, type AppState } from "../web/src/app/state.js";
import { createStore, type Store } from "../web/src/app/store.js";
import type { ReadingPositionSync } from "../web/src/story/reading-position-sync.js";
import { loadedStoryState } from "../web/src/story/state.js";

/**
 * `web/src/generation/actions.ts`'s Continue/Stop pipeline (#409 step 5),
 * matching the TUI's own `generate()`/`settleStoppedGeneration()`
 * (`tui/src/generation-action.ts`) over a fake `StoryApi`, the same pattern
 * `test/web-story-switch.integration.test.ts` uses for the take-switch race.
 * `generation/actions.ts` is wired to the REAL `story/actions.ts` (via
 * `createStoryActions`'s own `adoptPayload`/`isLocked`), not a hand-rolled
 * fake of it, so this suite also proves the two modules agree on the
 * version/route guards, not just that `generation/actions.ts` calls
 * something shaped like them.
 *
 * Correctness of the stop/save contract is the whole point here: every
 * branch below either commits the exact bytes the writer watched stream, or
 * visibly keeps them — never both, never neither.
 */

const STORY_ID = "story-1";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function stub(id: string, parentId: string | null): NodeStub {
  return {
    id,
    parentId,
    preview: id,
    words: 1,
    tokens: 1,
    childCount: 0,
    leafCount: 1,
    lastTouched: new Date(0).toISOString(),
    hasInstruction: false,
    activeChildId: null
  };
}

function pathNode(id: string, parentId: string | null, overrides: Partial<StoryPathNode> = {}): StoryPathNode {
  return {
    id,
    parentId,
    instruction: "",
    text: `${id} text`,
    model: "test",
    createdAt: new Date(0).toISOString(),
    activeChildId: null,
    ...overrides
  };
}

/** A linear story `ids[0] -> ids[1] -> ...`; `nodeOverrides` patches one
 * part's path node by id (e.g. to mark it `role: "summary"`). */
function linearPayload(
  ids: readonly string[],
  options: {
    readonly storyId?: string;
    readonly nodeOverrides?: Readonly<Record<string, Partial<StoryPathNode>>>;
    readonly chapterBreaks?: StoryPayload["chapterBreaks"];
  } = {}
): StoryPayload {
  const path: StoryPathNode[] = [];
  let parentId: string | null = null;
  for (const id of ids) {
    path.push(pathNode(id, parentId, options.nodeOverrides?.[id] ?? {}));
    parentId = id;
  }
  return {
    id: options.storyId ?? STORY_ID,
    title: "Test Story",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    nodes: ids.map((id, index) => stub(id, index === 0 ? null : ids[index - 1]!)),
    path,
    activeRootId: ids[0] ?? null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: options.chapterBreaks ?? []
  };
}

function connectedState(api: Partial<StoryApi>): ConnectionState {
  const readingPositions: ReadingPositionSync = {
    positionFor: () => Promise.resolve(null),
    record: () => {},
    flush: () => {}
  };
  return {
    kind: "connected",
    status: { project: "test", version: "0.0.0" },
    api: api as unknown as StoryApi,
    transport: {} as unknown as WebBridgeTransport,
    readingPositions
  };
}

function storeOpenOn(initial: StoryPayload, focusedPartId: string | null): Store<AppState> {
  const store = createStore(initialAppState({ kind: "story", id: STORY_ID }, null, "ink"));
  store.set((state) => ({ ...state, story: loadedStoryState(initial, focusedPartId) }));
  return store;
}

interface CapturedContinueCall {
  readonly storyId: string;
  readonly instruction: string;
  readonly genId: string;
  readonly target: ContinueTarget;
  readonly onDelta: (text: string) => void;
  readonly signal: AbortSignal;
  readonly callbacks: StreamCallbacks;
}

interface FakeApi {
  readonly api: Partial<StoryApi>;
  readonly continueCalls: CapturedContinueCall[];
  readonly createNodeCalls: { readonly storyId: string; readonly body: CreateNodeRequest }[];
  readonly loadStoryCalls: string[];
}

/**
 * A fake `StoryApi` that records every `continueStory`/`createNode`/
 * `loadStory` call. `continueStory` resolves via the `continueStory`
 * override the test supplies (usually a `deferred()` the test drives by
 * hand, or a function that calls `onDelta` and then rejects/resolves);
 * `createNode`/`loadStory` default to trivial successes so a test that does
 * not care about the save path does not have to stub them.
 */
/** The test-facing shape a `continueStory` fake returns — `droppedFacts` is
 * a fact-admission concern the web generation module does not read (out of
 * scope for step 5); `fakeApi` fills it in as `[]` before handing the result
 * back to the real `StoryApi` shape, so no test in this file has to. */
type FakeContinueStory = (
  storyId: string,
  instruction: string,
  genId: string,
  target: ContinueTarget,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  callbacks: StreamCallbacks
) => Promise<{ payload: StoryPayload } | null>;

function fakeApi(overrides: {
  readonly continueStory: FakeContinueStory;
  readonly createNode?: StoryApi["createNode"];
  readonly loadStory?: StoryApi["loadStory"];
}): FakeApi {
  const continueCalls: CapturedContinueCall[] = [];
  const createNodeCalls: { storyId: string; body: CreateNodeRequest }[] = [];
  const loadStoryCalls: string[] = [];
  const api: Partial<StoryApi> = {
    continueStory: async (storyId, instruction, genId, target, onDelta, signal, callbacks = {}) => {
      continueCalls.push({ storyId, instruction, genId, target, onDelta, signal, callbacks });
      const result = await overrides.continueStory(storyId, instruction, genId, target, onDelta, signal, callbacks);
      return result === null ? null : { payload: result.payload, droppedFacts: [] };
    },
    createNode: async (storyId, body) => {
      createNodeCalls.push({ storyId, body });
      if (overrides.createNode !== undefined) return overrides.createNode(storyId, body);
      return linearPayload(["a1", "a2"]);
    },
    loadStory: async (id) => {
      loadStoryCalls.push(id);
      if (overrides.loadStory !== undefined) return overrides.loadStory(id);
      return linearPayload(["a1"]);
    }
  };
  return { api, continueCalls, createNodeCalls, loadStoryCalls };
}

/** Wires `generation/actions.ts` to the REAL `story/actions.ts`, exactly as
 * `app/actions.ts` does — see this file's own doc for why. */
function createActionsForStore(store: Store<AppState>): {
  readonly story: StoryActions;
  readonly generation: GenerationActions;
  readonly scheduler: { current: ManualFlushScheduler | null };
} {
  const scheduler: { current: ManualFlushScheduler | null } = { current: null };
  const story = createStoryActions(store, {
    storyChanged: () => {},
    isLocked: (storyId) => generationLocks(store.get().generation, storyId)
  });
  const generation = createGenerationActions(store, {
    adoptPayload: story.adoptPayload,
    createScheduler: () => {
      scheduler.current = createManualFlushScheduler();
      return scheduler.current;
    }
  });
  return { story, generation, scheduler };
}

function toasts(store: Store<AppState>): string[] {
  return store.get().toasts.map((toast) => toast.message);
}

// ---------------------------------------------------------------------------
// planContinue matrix, exercised through the full continue() pipeline.
// ---------------------------------------------------------------------------

test("continue at the leaf appends: {appendTo, expectedTextHash}, instruction \"\"", async () => {
  const payload = linearPayload(["a1", "b1"]);
  const store = storeOpenOn(payload, "b1");
  const { api, continueCalls } = fakeApi({ continueStory: () => Promise.resolve({ payload }) });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.equal(continueCalls.length, 1);
  const call = continueCalls[0]!;
  assert.equal(call.instruction, "");
  assert.deepEqual(call.target, { appendTo: "b1", expectedTextHash: await textHash("b1 text") });
});

test("continue at a leaf with a chapter break anchored on it opens a new child", async () => {
  const payload = linearPayload(["a1", "b1"], {
    chapterBreaks: [{ id: "brk", parentPartId: "b1", title: "Two", createdAt: new Date(0).toISOString() }]
  });
  const store = storeOpenOn(payload, "b1");
  const { api, continueCalls } = fakeApi({ continueStory: () => Promise.resolve({ payload }) });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.deepEqual(continueCalls[0]!.target, { parentId: "b1" });
});

test("continue at a summary leaf opens a new child", async () => {
  const payload = linearPayload(["a1", "b1"], { nodeOverrides: { b1: { role: "summary" } } });
  const store = storeOpenOn(payload, "b1");
  const { api, continueCalls } = fakeApi({ continueStory: () => Promise.resolve({ payload }) });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.deepEqual(continueCalls[0]!.target, { parentId: "b1" });
});

test("continue focused on an earlier part opens a new take of the next part", async () => {
  const payload = linearPayload(["a1", "b1", "c1"]);
  const store = storeOpenOn(payload, "b1");
  const { api, continueCalls } = fakeApi({ continueStory: () => Promise.resolve({ payload }) });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.deepEqual(continueCalls[0]!.target, { parentId: "b1" });
});

test("continue on an empty story opens the first part", async () => {
  const payload = linearPayload([]);
  const store = storeOpenOn(payload, null);
  const { api, continueCalls } = fakeApi({ continueStory: () => Promise.resolve({ payload: linearPayload(["a1"]) }) });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.deepEqual(continueCalls[0]!.target, { parentId: null });
});

// ---------------------------------------------------------------------------
// rAF batching.
// ---------------------------------------------------------------------------

test("several deltas within one frame coalesce into a single store update", async () => {
  const payload = linearPayload(["a1", "b1"]);
  const store = storeOpenOn(payload, "a1"); // fromSeam: take mode, no crypto await before the call
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation, scheduler } = createActionsForStore(store);

  let notifyCount = 0;
  store.subscribe(() => { notifyCount += 1; });

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const onDelta = continueCalls[0]!.onDelta;
  const afterStart = notifyCount;

  onDelta("Hello ");
  onDelta("world");
  onDelta("!");
  const running = store.get().generation;
  assert.equal(running.kind, "running");
  assert.equal(running.kind === "running" ? running.text : "", "", "onDelta must not itself trigger a store update");
  assert.equal(notifyCount, afterStart);

  scheduler.current!.runPendingFlush();
  assert.equal(notifyCount, afterStart + 1, "three deltas within one frame must coalesce into one store.set");
  const flushed = store.get().generation;
  assert.equal(flushed.kind === "running" ? flushed.text : "", "Hello world!");

  continueCall.resolve({ payload: linearPayload(["a1", "b1", "a2"]) });
  await runPromise;
});

test("manuscriptGenerationView reports \"Waiting…\" until the first delta or "
  + "reasoning token arrives, never \"Writing…\" before admission is even "
  + "known (review fix #12)", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation, scheduler } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);

  const beforeAnything = manuscriptGenerationView(store.get().generation, STORY_ID);
  assert.equal(
    beforeAnything?.statusLabel,
    "Waiting…",
    "nothing has streamed yet (still inside the busy-retry window, from the " +
    "writer's point of view) — must never claim \"Writing…\" before the " +
    "server has actually admitted the request"
  );

  continueCalls[0]!.onDelta("now it starts");
  scheduler.current!.runPendingFlush();
  const afterDelta = manuscriptGenerationView(store.get().generation, STORY_ID);
  assert.equal(afterDelta?.statusLabel, "Writing…");

  continueCall.resolve({ payload: linearPayload(["a1", "a2"]) });
  await runPromise;
});

// ---------------------------------------------------------------------------
// Stop: createNode's exact body, raw append vs. trimmed take, and the tail.
// ---------------------------------------------------------------------------

test("Stop on an append commits raw (untrimmed) text with the append body, "
  + "including the withheld tail, under the streamed genId", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls, createNodeCalls } = fakeApi({
    continueStory: () => continueCall.promise,
    createNode: async () => linearPayload(["a1", "a2"])
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  call.onDelta(" continued");
  call.onDelta(" text  ");

  generation.stop();
  assert.equal(store.get().generation.kind, "settling");

  // The transport withholds the tail from onDelta once stopped, and hands it
  // over once, at terminal settlement.
  call.callbacks.onStopped?.(" plus a withheld tail.");
  continueCall.resolve(null);
  await runPromise;

  assert.equal(createNodeCalls.length, 1);
  assert.deepEqual(createNodeCalls[0]!.body, {
    appendTo: "a1",
    expectedTextHash: await textHash("a1 text"),
    instruction: "",
    text: " continued text   plus a withheld tail.",
    genId: call.genId
  });
  assert.equal(store.get().generation.kind, "idle");
});

test("Stop on a new take commits trimmed text with the take body, under the "
  + "streamed genId", async () => {
  const payload = linearPayload(["a1", "b1", "c1"]);
  const store = storeOpenOn(payload, "b1"); // earlier part -> new take of the next part
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls, createNodeCalls } = fakeApi({
    continueStory: () => continueCall.promise,
    createNode: async () => linearPayload(["a1", "b1", "d1"])
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  call.onDelta("  a new take of the part  ");

  generation.stop();
  call.callbacks.onStopped?.("");
  continueCall.resolve(null);
  await runPromise;

  // The wire call to the provider always carries the writer's raw (here
  // empty) instruction; the server resolves the same default itself. The
  // SAVED take's own instruction is the resolved default, matching the
  // TUI's own `stream.instruction` for a take.
  assert.equal(call.instruction, "");
  assert.equal(createNodeCalls.length, 1);
  assert.deepEqual(createNodeCalls[0]!.body, {
    parentId: "b1",
    instruction: DEFAULT_INSTRUCTION,
    text: "a new take of the part",
    genId: call.genId
  });
  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  if (story.kind === "loaded") {
    assert.equal(story.announcement, "Stopped. Part 3 kept.");
    assert.equal(story.focusedPartId, "d1");
  }
});

test("Stop with only whitespace streamed saves nothing and reloads instead", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls, createNodeCalls, loadStoryCalls } = fakeApi({
    continueStory: () => continueCall.promise
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  call.onDelta("   ");

  generation.stop();
  call.callbacks.onStopped?.("  \n ");
  continueCall.resolve(null);
  await runPromise;

  assert.equal(createNodeCalls.length, 0, "whitespace-only text must never be saved");
  assert.equal(loadStoryCalls.length, 1);
  assert.equal(store.get().generation.kind, "idle");
});

test("Stop but the generation finishes anyway: adopt the result, never a createNode save", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls, createNodeCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  continueCalls[0]!.onDelta("some text");

  generation.stop();
  // The result races the cancel and wins: the server finished the take
  // before the cancel was honored.
  const finished = linearPayload(["a1", "a2"]);
  continueCall.resolve({ payload: finished });
  await runPromise;

  assert.equal(createNodeCalls.length, 0, "a result that lands must never also be saved via createNode");
  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  if (story.kind === "loaded") assert.equal(story.payload, finished);
  assert.equal(store.get().generation.kind, "idle");
});

// ---------------------------------------------------------------------------
// Failures.
// ---------------------------------------------------------------------------

function timeoutFailure(message: string): ApiFailureError {
  return new ApiFailureError({ kind: "plain", code: "provider_failure", message, status: 504, timeout: "provider-idle" });
}

function plainProviderFailure(message: string): ApiFailureError {
  return new ApiFailureError({ kind: "plain", code: "provider_failure", message, status: 422 });
}

test("a timeout-class failure with substantive text saves it and toasts "
  + "\"<message> · generation stopped · text kept\"", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const { api, continueCalls, createNodeCalls } = fakeApi({
    continueStory: (_s, _i, _g, _t, onDelta) => {
      onDelta("partial prose");
      return Promise.reject(timeoutFailure("The provider timed out."));
    },
    createNode: async () => linearPayload(["a1", "a2"])
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.equal(createNodeCalls.length, 1, "a timeout-class failure must save the buffered text");
  assert.equal(continueCalls.length, 1);
  assert.ok(toasts(store).some((message) => message.includes("The provider timed out.")
    && message.includes("generation stopped")
    && message.includes("text kept")));
  assert.equal(store.get().generation.kind, "idle");
});

test("a plain connection failure (not a structured API error) with substantive "
  + "text is kept as \"unsaved\", never discarded and never auto-saved "
  + "(review fix #5: a save attempt right now would fail immediately too)", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const { api, createNodeCalls } = fakeApi({
    continueStory: (_s, _i, _g, _t, onDelta) => {
      onDelta("prose written before the socket dropped");
      return Promise.reject(new Error("1667 web connection closed (code 1006)"));
    },
    createNode: async () => linearPayload(["a1", "a2"])
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.equal(createNodeCalls.length, 0, "a connection loss must never attempt a save that cannot succeed");
  const unsaved = store.get().generation;
  assert.equal(unsaved.kind, "unsaved", "the prose must be kept visible, not discarded");
  assert.equal(unsaved.kind === "unsaved" ? unsaved.text : null, "prose written before the socket dropped");
});

test("a non-timeout provider rejection discards the buffered text (toast only)", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const { api, createNodeCalls, loadStoryCalls } = fakeApi({
    continueStory: (_s, _i, _g, _t, onDelta) => {
      onDelta("prose the provider then refused");
      return Promise.reject(plainProviderFailure("The model refused this request."));
    }
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.equal(createNodeCalls.length, 0, "a rejected (non-timeout) generation must never be saved");
  assert.equal(loadStoryCalls.length, 0);
  assert.ok(toasts(store).some((message) => message.includes("The model refused this request.")));
  assert.equal(store.get().generation.kind, "idle");
});

test("Stop that races a non-timeout rejection still discards: refused prose is never saved", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls, createNodeCalls } = fakeApi({
    continueStory: () => continueCall.promise
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  continueCalls[0]!.onDelta("prose the provider then refused");
  generation.stop();
  assert.equal(store.get().generation.kind, "settling");
  continueCall.reject(plainProviderFailure("The model refused this request."));
  await runPromise;

  assert.equal(createNodeCalls.length, 0, "a rejection after Stop must not be saved");
  assert.ok(toasts(store).some((message) => message.includes("The model refused this request.")));
  assert.equal(store.get().generation.kind, "idle");
});

test("an uncertain mutation outcome reloads the story instead of guessing", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const reloaded = linearPayload(["a1", "a2"]);
  const { api, loadStoryCalls } = fakeApi({
    continueStory: () => Promise.reject(
      new WebBridgeTransportError(
        { kind: "plain", code: "provider_failure", message: "Unknown outcome.", status: 500 },
        "uncertain",
        undefined
      )
    ),
    loadStory: async () => reloaded
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.equal(loadStoryCalls.length, 1);
  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  if (story.kind === "loaded") assert.equal(story.payload, reloaded);
});

test("a revision_conflict at Continue's own admission reloads and adopts the "
  + "current story, then allows another attempt (review fix #2)", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const reloaded = linearPayload(["a1", "a2"]);
  const conflict = new ApiFailureError({ kind: "plain", code: "revision_conflict", message: "stale", status: 409 });
  const { api, loadStoryCalls } = fakeApi({
    continueStory: () => Promise.reject(conflict),
    loadStory: async () => reloaded
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.equal(loadStoryCalls.length, 1, "the stale cache must be refreshed, not left to repeat the same conflict");
  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  if (story.kind === "loaded") assert.equal(story.payload, reloaded);
  assert.deepEqual(toasts(store), ["The story changed in another window. It was reloaded."]);
  assert.equal(store.get().generation.kind, "idle", "must allow another attempt, never stay stuck");
});

test("still busy after admission retries: toast \"Another window is writing "
  + "in this story.\"", { timeout: 5_000 }, async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const busy = new ApiFailureError({ kind: "plain", code: "resource_busy", message: "busy", status: 409 });
  const { api } = fakeApi({ continueStory: () => Promise.reject(busy) });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  await generation.continue();

  assert.deepEqual(toasts(store), ["Another window is writing in this story."]);
  assert.equal(store.get().generation.kind, "idle");
});

// ---------------------------------------------------------------------------
// Save-time revision_conflict / resource_busy, and a persistent save failure.
// ---------------------------------------------------------------------------

test("a revision_conflict on save reloads once and retries the same commit", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  let createNodeAttempts = 0;
  const { api, continueCalls, loadStoryCalls } = fakeApi({
    continueStory: () => continueCall.promise,
    createNode: async () => {
      createNodeAttempts += 1;
      if (createNodeAttempts === 1) {
        throw new ApiFailureError({ kind: "plain", code: "revision_conflict", message: "stale", status: 409 });
      }
      return linearPayload(["a1", "a2"]);
    }
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  call.onDelta("text that races a conflicting write");
  generation.stop();
  call.callbacks.onStopped?.("");
  continueCall.resolve(null);
  await runPromise;

  assert.equal(createNodeAttempts, 2, "must retry exactly once after reloading");
  assert.equal(loadStoryCalls.length, 1);
  assert.equal(store.get().generation.kind, "idle");
});

test("resource_busy on save retries automatically and then commits", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  let saveAttempts = 0;
  const { api, continueCalls, createNodeCalls } = fakeApi({
    continueStory: () => continueCall.promise,
    createNode: async () => {
      saveAttempts += 1;
      if (saveAttempts < 2) {
        throw new ApiFailureError({ kind: "plain", code: "resource_busy", message: "busy", status: 409 });
      }
      return linearPayload(["a1", "a2"]);
    }
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  continueCalls[0]!.onDelta("some prose");
  generation.stop();
  continueCalls[0]!.callbacks.onStopped?.("");
  continueCall.resolve(null);
  await runPromise;

  assert.equal(saveAttempts, 2);
  assert.equal(createNodeCalls.length, 2);
  assert.equal(store.get().generation.kind, "idle");
});

test("a persistent save failure keeps the text as \"unsaved\"; retrySave reuses "
  + "the same genId and succeeds", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  let saveAttempts = 0;
  const { api, continueCalls, createNodeCalls } = fakeApi({
    continueStory: () => continueCall.promise,
    createNode: async () => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("disk full");
      return linearPayload(["a1", "a2"]);
    },
    loadStory: async () => linearPayload(["a1"])
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  call.onDelta("text that failed to save");
  generation.stop();
  call.callbacks.onStopped?.("");
  continueCall.resolve(null);
  await runPromise;

  const unsaved = store.get().generation;
  assert.equal(unsaved.kind, "unsaved");
  assert.equal(unsaved.kind === "unsaved" ? unsaved.genId : null, call.genId);
  assert.equal(unsaved.kind === "unsaved" ? unsaved.text : null, "text that failed to save");
  assert.equal(createNodeCalls.length, 1);

  await generation.retrySave();

  assert.equal(createNodeCalls.length, 2);
  assert.equal(createNodeCalls[1]!.body.genId, call.genId, "retrySave must reuse the original genId");
  assert.equal(store.get().generation.kind, "idle");
});

test("stop() is a no-op once a timeout-class failure's own save has already "
  + "failed and left the run \"unsaved\" — never a stuck \"Saving…\" "
  + "(review fix #4)", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  let saveAttempts = 0;
  const { api, createNodeCalls } = fakeApi({
    continueStory: (_s, _i, _g, _t, onDelta) => {
      onDelta("partial prose");
      return Promise.reject(timeoutFailure("The provider timed out."));
    },
    createNode: async () => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error("disk full");
      return linearPayload(["a1", "a2"]);
    },
    loadStory: async () => linearPayload(["a1"])
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  // A timeout-class failure with substantive text attempts a save (the
  // "save" disposition); that save itself then fails, leaving the run
  // "unsaved" with its closure still alive for Copy/Discard/Retry.
  await generation.continue();
  assert.equal(createNodeCalls.length, 1);
  assert.equal(store.get().generation.kind, "unsaved");

  // Before item 6's single-phase refactor, calling stop() here published
  // "settling" and aborted an already-dead controller — nothing ever
  // resolved that, so the bar stayed stuck on "Saving…" forever, and
  // continue() refused forever after (activeRun never cleared). stop() must
  // now recognize there is nothing running to stop and leave the "unsaved"
  // card exactly as it was.
  assert.equal(generation.stop(), false, "there is nothing running to stop");
  assert.equal(store.get().generation.kind, "unsaved", "must not flip to a permanently-stuck \"settling\"");

  // The run must still be usable afterward — retrySave (not just discard)
  // proves the closure was never wedged.
  await generation.retrySave();
  assert.equal(createNodeCalls.length, 2);
  assert.equal(store.get().generation.kind, "idle");
});

test("discardUnsaved clears the unsaved generation without saving", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls, createNodeCalls } = fakeApi({
    continueStory: () => continueCall.promise,
    createNode: async () => { throw new Error("disk full"); }
  });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  call.onDelta("text nobody will keep");
  generation.stop();
  call.callbacks.onStopped?.("");
  continueCall.resolve(null);
  await runPromise;

  assert.equal(store.get().generation.kind, "unsaved");
  generation.discardUnsaved();
  assert.equal(store.get().generation.kind, "idle");
  assert.equal(createNodeCalls.length, 1, "discard must never attempt another save");
});

// ---------------------------------------------------------------------------
// Background writing: route change mid-stream, and focus discipline on landing.
// ---------------------------------------------------------------------------

test("a route change mid-stream keeps the generation running in the background "
  + "and does not adopt into the story now open", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  continueCalls[0]!.onDelta("writing along");

  // The reader navigates to a different story entirely.
  const otherPayload = linearPayload(["z1"], { storyId: "story-2" });
  store.set((state) => ({
    ...state,
    route: { kind: "story", id: "story-2" },
    story: loadedStoryState(otherPayload, "z1")
  }));

  const landed = linearPayload(["a1", "a2"]);
  continueCall.resolve({ payload: landed });
  await runPromise;

  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  if (story.kind === "loaded") {
    assert.equal(story.payload.id, "story-2", "the story now open must not be replaced by the background landing");
  }
  assert.ok(toasts(store).some((message) => message.includes("Part 2 written in Test Story.")));
  assert.equal(store.get().generation.kind, "idle");
});

test("a landed new take moves focus onto the new leaf when the reader never moved away", async () => {
  const payload = linearPayload(["a1", "b1", "c1"]);
  const store = storeOpenOn(payload, "b1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const landed = linearPayload(["a1", "b1", "d1"]);
  continueCall.resolve({ payload: landed });
  await runPromise;

  const story = store.get().story;
  assert.equal(story.kind, "loaded");
  if (story.kind === "loaded") assert.equal(story.focusedPartId, "d1");
});

test("if the reader moved focus before landing, the landing does not move it", async () => {
  const payload = linearPayload(["a1", "b1", "c1"]);
  const store = storeOpenOn(payload, "b1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { story, generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  story.focusPart("a1"); // the reader scrolls up mid-stream

  const landed = linearPayload(["a1", "b1", "d1"]);
  continueCall.resolve({ payload: landed });
  await runPromise;

  const finalStory = store.get().story;
  assert.equal(finalStory.kind, "loaded");
  if (finalStory.kind === "loaded") {
    assert.equal(finalStory.focusedPartId, "a1", "landing must never move focus out from under the reader");
  }
});

// ---------------------------------------------------------------------------
// Reconnect and stale callbacks.
// ---------------------------------------------------------------------------

test("callbacks from a run are ignored once the connection has been replaced (reconnect)", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation, scheduler } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  call.onDelta("before reconnect");
  scheduler.current!.runPendingFlush();
  const beforeReconnect = store.get().generation;
  assert.equal(beforeReconnect.kind === "running" ? beforeReconnect.text : null, "before reconnect");

  // A brand new connection replaces the old one (the Reconnect button, after
  // the old connection already closed).
  const { api: newApi } = fakeApi({ continueStory: () => new Promise(() => {}) });
  store.set((state) => ({ ...state, connection: connectedState(newApi) }));

  call.onDelta("after reconnect, must be dropped");
  scheduler.current!.runPendingFlush();
  const afterReconnect = store.get().generation;
  assert.equal(
    afterReconnect.kind === "running" ? afterReconnect.text : null,
    "before reconnect",
    "a delta delivered after a reconnect must never reach the store"
  );

  continueCall.reject(new Error("1667 web connection closed (code 1006)"));
  await runPromise.catch(() => {});
});

test("callbacks never throw once their run has been reset (superseded/completed)", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  const call = continueCalls[0]!;
  continueCall.resolve({ payload: linearPayload(["a1", "a2"]) });
  await runPromise;
  assert.equal(store.get().generation.kind, "idle");

  // The run has fully settled; any further callback a since-abandoned
  // transport call might still invoke must be a harmless no-op, never a
  // throw (a throw would cancel a live call in the real transport).
  assert.doesNotThrow(() => call.onDelta("late delta"));
  assert.doesNotThrow(() => call.callbacks.onStopped?.("late tail"));
  assert.doesNotThrow(() => call.callbacks.onReasoning?.({ text: "late", tokenCount: 1 }));
  assert.doesNotThrow(() => call.callbacks.onReasoningStopped?.("late reasoning tail"));
  assert.equal(store.get().generation.kind, "idle", "late callbacks must not resurrect a finished generation");
});

// ---------------------------------------------------------------------------
// Locking.
// ---------------------------------------------------------------------------

test("switchTake and switchTakeTo refuse with a toast while a generation is "
  + "writing in this story", async () => {
  const payload = linearPayload(["a1"]);
  const store = storeOpenOn(payload, "a1");
  const continueCall = deferred<{ payload: StoryPayload } | null>();
  const { api, continueCalls } = fakeApi({ continueStory: () => continueCall.promise });
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const { story, generation } = createActionsForStore(store);

  const runPromise = generation.continue();
  await waitFor(() => continueCalls.length === 1);
  assert.equal(generationLocks(store.get().generation, STORY_ID), true);

  story.switchTake("a1", 1);
  story.switchTakeTo("a1", "somewhere");
  assert.deepEqual(toasts(store), [STORY_LOCKED_TOAST, STORY_LOCKED_TOAST]);

  generation.stop();
  continueCalls[0]!.callbacks.onStopped?.("");
  continueCall.resolve(null);
  await runPromise;
  assert.equal(generationLocks(store.get().generation, STORY_ID), false);
});
