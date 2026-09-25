import assert from "node:assert/strict";
import test from "node:test";
import type { StoryApi } from "../client/api.js";
import type { WebBridgeTransport } from "../client/web-bridge-transport.js";
import type { StorySummary } from "../shared/types.js";
import { createLibraryActions } from "../web/src/library/actions.js";
import type { ConnectionState } from "../web/src/app/connection.js";
import { initialAppState, type AppState } from "../web/src/app/state.js";
import { createStore, type Store } from "../web/src/app/store.js";

/**
 * Codex review (web/step-3-shell): `listStories()` runs on connect, on
 * `visibilitychange`, and after every Library mutation, so calls overlap and
 * their responses can resolve in any order. These exercise
 * `createLibraryActions` and `createStore` together (an integration test —
 * `library/actions.ts` alone has nothing to race against) with a fake
 * `StoryApi` whose `listStories()` resolves under the test's own control, so
 * the ordering is deterministic rather than timing-dependent.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function summary(id: string): StorySummary {
  return {
    id,
    title: id,
    updatedAt: new Date(0).toISOString(),
    partCount: 1,
    words: 0,
    forked: false,
    lineCount: 1
  };
}

function connectedState(api: Partial<StoryApi>): ConnectionState {
  return {
    kind: "connected",
    status: { project: "test", version: "0.0.0" },
    api: api as unknown as StoryApi,
    transport: {} as unknown as WebBridgeTransport
  };
}

function libraryStore(): Store<AppState> {
  return createStore(initialAppState({ kind: "library" }, null, "ink"));
}

test("a slower response from an earlier-issued refresh never overwrites a "
  + "faster, later-issued one", async () => {
  const first = deferred<StorySummary[]>();
  const second = deferred<StorySummary[]>();
  let calls = 0;
  const api: Partial<StoryApi> = {
    listStories: () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    }
  };

  const store = libraryStore();
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const library = createLibraryActions(store, { titleChanged: () => {} });

  // Two overlapping refreshes -- e.g. a post-delete refresh issued while an
  // earlier visibilitychange refresh is still in flight.
  const firstRefresh = library.refresh();
  const secondRefresh = library.refresh();

  // The SECOND (later-issued) call's response -- reflecting reality after a
  // delete -- arrives FIRST.
  const freshList = [summary("b")];
  second.resolve(freshList);
  await secondRefresh;
  assert.deepEqual(store.get().library.stories, freshList);

  // The FIRST (earlier-issued) call's response -- stale, from before the
  // delete -- arrives LAST. It must not resurrect the deleted row.
  const staleList = [summary("a"), summary("b")];
  first.resolve(staleList);
  await firstRefresh;

  assert.deepEqual(store.get().library.stories, freshList);
});

test("a response from a connection that has since been replaced is dropped, "
  + "even with no newer refresh in flight", async () => {
  const pending = deferred<StorySummary[]>();
  const api: Partial<StoryApi> = { listStories: () => pending.promise };

  const store = libraryStore();
  store.set((state) => ({ ...state, connection: connectedState(api) }));
  const library = createLibraryActions(store, { titleChanged: () => {} });

  const refreshPromise = library.refresh();

  // The connection is replaced (e.g. a reconnect) before the response
  // arrives, and something else already gave the list its post-reconnect
  // shape.
  const reconnectedApi: Partial<StoryApi> = { listStories: () => Promise.resolve([]) };
  store.set((state) => ({ ...state, connection: connectedState(reconnectedApi) }));
  const postReconnectList = [summary("after-reconnect")];
  store.set((state) => ({ ...state, library: { ...state.library, stories: postReconnectList } }));

  // The old connection's slow response finally arrives.
  pending.resolve([summary("stale-from-old-connection")]);
  await refreshPromise;

  assert.deepEqual(store.get().library.stories, postReconnectList);
});
