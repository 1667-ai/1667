import assert from "node:assert/strict";
import test from "node:test";
import type { StoryApi } from "../client/api.js";
import { ApiFailureError } from "../client/api-error.js";
import type { WebBridgeTransport } from "../client/web-bridge-transport.js";
import type { NodeStub, StoryPathNode, StoryPayload } from "../shared/types.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { createStoryActions } from "../web/src/story/actions.js";
import type { ConnectionState } from "../web/src/app/connection.js";
import { initialAppState, type AppState } from "../web/src/app/state.js";
import { createStore, type Store } from "../web/src/app/store.js";
import type { ReadingPositionSync } from "../web/src/story/reading-position-sync.js";
import { effectiveFocusedPartId, loadedStoryState } from "../web/src/story/state.js";

/**
 * `web/src/story/actions.ts`'s take-switch flow (#409 step 4): server-
 * authoritative with an optimistic indicator, coalesced under rapid presses,
 * and guarded against a stale response from an older request or a route the
 * reader has since left. Exercises `createStoryActions` and `createStore`
 * together (an integration test — the action module alone has nothing to
 * race against) with a fake `StoryApi` whose `switchLine`/`loadStory` resolve
 * under the test's own control, matching
 * `test/web-library-refresh-race.integration.test.ts`'s pattern for the
 * equivalent Library race.
 */

const STORY_ID = "story-1";
const SIBLINGS = ["a", "b", "c", "d"] as const;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stub(id: string): NodeStub {
  return {
    id,
    parentId: null,
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

function pathNode(id: string): StoryPathNode {
  return {
    id,
    parentId: null,
    instruction: "",
    text: id,
    model: "test",
    createdAt: new Date(0).toISOString(),
    activeChildId: null
  };
}

/** Four root-level siblings (`a`–`d`, all `parentId: null`); `activeId` is
 * the one on the path. `resolveSwitchTarget` walks this same sibling list
 * regardless of which one is "active", so every take-switch target in these
 * tests stays valid across the whole sequence. */
function payload(activeId: string, aggregateVersion?: StoryAggregateVersion): StoryPayload {
  return {
    id: STORY_ID,
    title: "Test",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    nodes: SIBLINGS.map((id) => stub(id)),
    path: [pathNode(activeId)],
    activeRootId: activeId,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    ...(aggregateVersion === undefined ? {} : { aggregateVersion })
  };
}

function v6(revision: number): StoryAggregateVersion {
  return { kind: "v6", revision: String(revision).padStart(20, "0") };
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

function storeOpenOn(initial: StoryPayload): Store<AppState> {
  const store = createStore(initialAppState({ kind: "story", id: STORY_ID }, null, "ink"));
  store.set((state) => ({ ...state, story: loadedStoryState(initial, initial.path[0]!.id) }));
  return store;
}

function switchingTarget(store: Store<AppState>): string | null {
  const story = store.get().story;
  return story.kind === "loaded" ? story.switching?.targetId ?? null : null;
}

/** Three-row fixture for the Defect 4 regression below: a fixed `"anchor"`
 * row, three switchable siblings (`mid-b`/`mid-c`/`mid-d`), and each
 * sibling's own single-child "tail" row. Unlike `payload()` above — where
 * the switched row and the path's only row are the same node, so a stale
 * `focusedPartId` and the correct one always happen to coincide — switching
 * `mid-b` to `mid-c` here truly drops `mid-b` from the path while the leaf
 * moves to `mid-c`'s own tail, not to `mid-c` itself. That gap is what lets
 * this fixture actually exercise the fallback-to-leaf bug. */
const MIDS = ["mid-b", "mid-c", "mid-d"] as const;

function tailOf(mid: string): string {
  return `${mid}-tail`;
}

function deepPayload(activeMid: string, aggregateVersion?: StoryAggregateVersion): StoryPayload {
  return {
    id: STORY_ID,
    title: "Test",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    nodes: [
      stub("anchor"),
      ...MIDS.map((mid) => ({ ...stub(mid), parentId: "anchor" })),
      ...MIDS.map((mid) => ({ ...stub(tailOf(mid)), parentId: mid }))
    ],
    path: [
      pathNode("anchor"),
      { ...pathNode(activeMid), parentId: "anchor" },
      { ...pathNode(tailOf(activeMid)), parentId: activeMid }
    ],
    activeRootId: "anchor",
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    ...(aggregateVersion === undefined ? {} : { aggregateVersion })
  };
}

test("three rapid switchTake presses make at most two switchLine calls "
  + "and land on the target three steps over", async () => {
  const calls: string[] = [];
  const responses = new Map<string, ReturnType<typeof deferred<StoryPayload>>>();
  const api: Partial<StoryApi> = {
    switchLine: (_storyId, nodeId) => {
      calls.push(nodeId);
      const response = deferred<StoryPayload>();
      responses.set(nodeId, response);
      return response.promise;
    }
  };

  const store = storeOpenOn(payload("a"));
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const story = createStoryActions(store, { storyChanged: () => {} });

  // a -> b -> c -> d, three rapid presses before anything resolves.
  story.switchTake("a", 1);
  story.switchTake("a", 1);
  story.switchTake("a", 1);

  assert.deepEqual(calls, ["b"]);
  assert.equal(switchingTarget(store), "d");

  responses.get("b")!.resolve(payload("b", v6(1)));
  // The in-flight request landed on "b", but the desired target moved on to
  // "d" while it was in flight -- exactly one more request goes out.
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ["b", "d"]);

  responses.get("d")!.resolve(payload("d", v6(2)));
  await waitFor(() => switchingTarget(store) === null);

  const finalStory = store.get().story;
  assert.equal(finalStory.kind, "loaded");
  if (finalStory.kind === "loaded") {
    assert.equal(finalStory.payload.path[0]!.id, "d");
    assert.equal(finalStory.focusedPartId, "d");
    assert.equal(finalStory.switching, null);
  }
});

test("a late, older loadStory response does not replace a newer take-switch payload", async () => {
  const switchResponse = deferred<StoryPayload>();
  const loadResponse = deferred<StoryPayload>();
  const api: Partial<StoryApi> = {
    switchLine: () => switchResponse.promise,
    loadStory: () => loadResponse.promise
  };

  const store = storeOpenOn(payload("a", v6(1)));
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const story = createStoryActions(store, { storyChanged: () => {} });

  // An older `load()` is already in flight (e.g. a reload) when the reader
  // switches takes; the switch's response arrives and lands FIRST.
  const loadPromise = story.load(STORY_ID);
  story.switchTake("a", 1);
  switchResponse.resolve(payload("b", v6(2)));
  await waitFor(() => switchingTarget(store) === null);

  // The stale `load()` (version 1, older than the switch's version 2)
  // resolves after the switch already landed a newer payload.
  loadResponse.resolve(payload("a", v6(1)));
  await loadPromise;

  const finalStory = store.get().story;
  assert.equal(finalStory.kind, "loaded");
  if (finalStory.kind === "loaded") {
    assert.equal(finalStory.payload.path[0]!.id, "b");
  }
});

test("a switch that lands after the route has moved on is dropped", async () => {
  const switchResponse = deferred<StoryPayload>();
  const api: Partial<StoryApi> = { switchLine: () => switchResponse.promise };

  const store = storeOpenOn(payload("a"));
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const story = createStoryActions(store, { storyChanged: () => {} });

  story.switchTake("a", 1);
  assert.equal(switchingTarget(store), "b");

  // The reader navigates to a different story before the switch's response
  // arrives.
  store.set((state) => ({ ...state, route: { kind: "story", id: "story-2" } }));
  switchResponse.resolve(payload("b", v6(2)));

  // Nothing to await on directly (the drop is a route check with no further
  // state change); give the microtask queue a turn, then confirm the
  // now-unrelated story-1 state was left exactly as the navigation found it.
  await Promise.resolve();
  await Promise.resolve();
  store.set((state) => ({ ...state, route: { kind: "story", id: STORY_ID } }));
  const finalStory = store.get().story;
  assert.equal(finalStory.kind, "loaded");
  if (finalStory.kind === "loaded") {
    assert.equal(finalStory.payload.path[0]!.id, "a");
    assert.deepEqual(finalStory.switching, { partId: "a", targetId: "b" });
  }
});

test("resource_busy is retried and the switch still lands", async () => {
  let attempts = 0;
  const api: Partial<StoryApi> = {
    switchLine: async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new ApiFailureError({
          kind: "plain",
          code: "resource_busy",
          message: "busy",
          status: 409
        });
      }
      return payload("b", v6(1));
    }
  };

  const store = storeOpenOn(payload("a"));
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const story = createStoryActions(store, { storyChanged: () => {} });

  story.switchTake("a", 1);
  await waitFor(() => switchingTarget(store) === null, 5_000);

  assert.equal(attempts, 3);
  const finalStory = store.get().story;
  assert.equal(finalStory.kind, "loaded");
  if (finalStory.kind === "loaded") {
    assert.equal(finalStory.payload.path[0]!.id, "b");
  }
});

test("an intermediate switch landing rebases focus onto the take that just "
  + "landed, so a press right after still advances the same part (review "
  + "fix: rapid take switching)", async () => {
  const calls: string[] = [];
  const responses = new Map<string, ReturnType<typeof deferred<StoryPayload>>>();
  const api: Partial<StoryApi> = {
    switchLine: (_storyId, nodeId) => {
      calls.push(nodeId);
      const response = deferred<StoryPayload>();
      responses.set(nodeId, response);
      return response.promise;
    }
  };

  const store = createStore(initialAppState({ kind: "story", id: STORY_ID }, null, "ink"));
  store.set((state) => ({
    ...state,
    story: loadedStoryState(deepPayload("mid-b"), "mid-b"),
    connection: connectedState(api)
  }));
  const story = createStoryActions(store, { storyChanged: () => {} });

  // Two rapid presses on "mid-b" (the row carrying focus, not the leaf):
  // one request goes out for "mid-c" while the desired target moves on to
  // "mid-d" before it resolves — same coalescing as the plain fixture's
  // three-rapid-press test above.
  story.switchTake("mid-b", 1);
  story.switchTake("mid-b", 1);
  assert.deepEqual(calls, ["mid-c"]);
  assert.equal(switchingTarget(store), "mid-d");

  // "mid-b" -> "mid-c" lands while "mid-d" is still queued. The loop adopts
  // it and fires the next request, but must also rebase `focusedPartId` and
  // `switching.partId` off "mid-b" -- absent from "mid-c"'s path -- onto
  // "mid-c", the take actually showing now.
  responses.get("mid-c")!.resolve(deepPayload("mid-c", v6(1)));
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ["mid-c", "mid-d"]);

  const midLanding = store.get().story;
  assert.equal(midLanding.kind, "loaded");
  if (midLanding.kind !== "loaded") return;
  assert.equal(midLanding.focusedPartId, "mid-c");
  assert.deepEqual(midLanding.switching, { partId: "mid-c", targetId: "mid-d" });

  // The same value `StoryView.tsx`'s take-next handler reads before issuing
  // a press. Unfixed, the stale "mid-b" is absent from the landed path and
  // this falls back to the leaf ("mid-c-tail", a childless part with no
  // sibling to switch to) instead of "mid-c".
  const focusedBeforeThirdPress = effectiveFocusedPartId(midLanding);
  assert.equal(focusedBeforeThirdPress, "mid-c");

  // Third press, still before "mid-d" resolves: continues the very same
  // switch sequence (b -> c -> d -> wraps to b) instead of acting on the
  // wrong part or silently doing nothing.
  story.switchTake(focusedBeforeThirdPress!, 1);
  assert.equal(switchingTarget(store), "mid-b");

  responses.get("mid-d")!.resolve(deepPayload("mid-d", v6(2)));
  await waitFor(() => calls.length === 3);
  assert.deepEqual(calls, ["mid-c", "mid-d", "mid-b"]);

  responses.get("mid-b")!.resolve(deepPayload("mid-b", v6(3)));
  await waitFor(() => switchingTarget(store) === null);

  const finalStory = store.get().story;
  assert.equal(finalStory.kind, "loaded");
  if (finalStory.kind === "loaded") {
    assert.equal(finalStory.payload.path[1]!.id, "mid-b");
    assert.equal(finalStory.focusedPartId, "mid-b");
    assert.equal(finalStory.switching, null);
  }
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
