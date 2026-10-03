import type { ContinueTarget, StoryApi, StreamCallbacks } from "../client/api.js";
import { ApiFailureError } from "../client/api-error.js";
import { WebBridgeTransportError, type WebBridgeTransport } from "../client/web-bridge-transport.js";
import type { CreateNodeRequest, NodeStub, StoryNode, StoryPathNode, StoryPayload } from "../shared/types.js";
import type { ConnectionState } from "../web/src/app/connection.js";
import { createContentActions, type ContentActions } from "../web/src/app/content-actions.js";
import { initialAppState, type AppState } from "../web/src/app/state.js";
import { createStore, type Store } from "../web/src/app/store.js";
import { createManualFlushScheduler, type ManualFlushScheduler } from "../web/src/generation/stream-buffer.js";
import type { ReadingPositionSync } from "../web/src/story/reading-position-sync.js";
import { loadedStoryState } from "../web/src/story/state.js";

/**
 * Shared scaffolding for the web writing-loop integration suites
 * (`web-compose`, `web-editor`): a fake `StoryApi` that records its calls,
 * linear story payloads, and a store wired to the REAL app actions — the
 * same wiring `app/bootstrap.ts` builds, minus the network.
 */

export const STORY_ID = "story-1";

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function stub(id: string, parentId: string | null, text: string): NodeStub {
  return {
    id,
    parentId,
    preview: text,
    words: text.split(/\s+/).filter(Boolean).length,
    tokens: 1,
    childCount: 0,
    leafCount: 1,
    lastTouched: new Date(0).toISOString(),
    hasInstruction: false,
    activeChildId: null
  };
}

export function pathNode(id: string, parentId: string | null, overrides: Partial<StoryPathNode> = {}): StoryPathNode {
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
 * part's path node by id (e.g. `role: "summary"`, or a saved `instruction`). */
export function linearPayload(
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
    nodes: path.map((node, index) => stub(node.id, index === 0 ? null : path[index - 1]!.id, node.text)),
    path,
    activeRootId: ids[0] ?? null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: options.chapterBreaks ?? []
  };
}

export function connectedState(api: StoryApi): ConnectionState {
  const readingPositions: ReadingPositionSync = {
    positionFor: () => Promise.resolve(null),
    record: () => {},
    flush: () => {}
  };
  return {
    kind: "connected",
    status: { project: "test", version: "0.0.0" },
    api,
    transport: {} as unknown as WebBridgeTransport,
    readingPositions
  };
}

export function storeOpenOn(initial: StoryPayload, focusedPartId: string | null): Store<AppState> {
  const store = createStore(initialAppState({ kind: "story", id: STORY_ID }, null, "ink"));
  store.set((state) => ({ ...state, story: loadedStoryState(initial, focusedPartId) }));
  return store;
}

export function toasts(store: Store<AppState>): string[] {
  return store.get().toasts.map((toast) => toast.message);
}

export function plainFailure(code: string, message: string, status = 409): ApiFailureError {
  return new ApiFailureError({ kind: "plain", code, message, status } as ConstructorParameters<typeof ApiFailureError>[0]);
}

export function providerFailure(message: string): ApiFailureError {
  return plainFailure("provider_failure", message, 422);
}

/** A failure that does not say whether the call went through. */
export function lostAnswer(): WebBridgeTransportError {
  return new WebBridgeTransportError(
    { kind: "plain", code: "provider_failure", message: "unsure", status: 500 } as ConstructorParameters<typeof ApiFailureError>[0],
    "uncertain",
    undefined
  );
}

export interface ContinueCall {
  readonly storyId: string;
  readonly instruction: string;
  readonly genId: string;
  readonly target: ContinueTarget;
  readonly onDelta: (text: string) => void;
  readonly signal: AbortSignal;
  readonly callbacks: StreamCallbacks;
}

export type FakeContinueStory = (
  storyId: string,
  instruction: string,
  genId: string,
  target: ContinueTarget,
  onDelta: (text: string) => void,
  signal: AbortSignal,
  callbacks: StreamCallbacks
) => Promise<{ payload: StoryPayload } | null>;

export interface FakeApiOptions {
  readonly continueStory?: FakeContinueStory;
  readonly createNode?: StoryApi["createNode"];
  readonly editNode?: StoryApi["editNode"];
  readonly deleteNode?: StoryApi["deleteNode"];
  readonly loadStory?: StoryApi["loadStory"];
  readonly getTakeLine?: StoryApi["getTakeLine"];
  readonly getSettings?: StoryApi["getSettings"];
  readonly defaultContinueDirection?: string;
  /** Any other `StoryApi` method, by name (a chapter or tag call). */
  readonly methods?: Readonly<Record<string, (...args: never[]) => unknown>>;
}

export interface FakeApi {
  /** A complete `StoryApi`: a method the test did not configure throws
   * `unexpected call: <name>` — and is still recorded. */
  readonly api: StoryApi;
  readonly continueCalls: ContinueCall[];
  readonly createNodeCalls: { readonly storyId: string; readonly body: CreateNodeRequest }[];
  readonly editNodeCalls: {
    readonly storyId: string;
    readonly node: StoryNode;
    readonly patch: { instruction?: string; text?: string };
  }[];
  readonly deleteNodeCalls: { readonly storyId: string; readonly nodeId: string; readonly count: number }[];
  readonly loadStoryCalls: string[];
  /** Every call to any method, by name, in order. */
  readonly calls: string[];
  /** Replaces what `continueStory` does from now on. */
  setContinueStory(run: FakeContinueStory): void;
}

/**
 * Records every call. Only `listStories` (the Library refresh a landing
 * triggers) answers by itself; every other method must be configured by the
 * test or it throws — so a test never passes because of a quiet default.
 */
export function fakeApi(overrides: FakeApiOptions = {}): FakeApi {
  const continueCalls: ContinueCall[] = [];
  const createNodeCalls: FakeApi["createNodeCalls"] = [];
  const editNodeCalls: FakeApi["editNodeCalls"] = [];
  const deleteNodeCalls: FakeApi["deleteNodeCalls"] = [];
  const loadStoryCalls: string[] = [];
  const calls: string[] = [];
  let continueRun = overrides.continueStory;

  const implemented: Record<string, (...args: never[]) => unknown> = {
    listStories: async () => [],
    getSettings: async () => {
      if (overrides.getSettings !== undefined) return overrides.getSettings();
      if (overrides.defaultContinueDirection === undefined) throw new Error("no settings in this fake");
      return { activeWriting: { defaultContinueDirection: overrides.defaultContinueDirection } } as never;
    },
    continueStory: async (
      storyId: string, instruction: string, genId: string, target: ContinueTarget,
      onDelta: (text: string) => void, signal: AbortSignal, callbacks: StreamCallbacks = {}
    ) => {
      continueCalls.push({ storyId, instruction, genId, target, onDelta, signal, callbacks });
      if (continueRun === undefined) throw new Error("unexpected call: continueStory");
      const result = await continueRun(storyId, instruction, genId, target, onDelta, signal, callbacks);
      return result === null ? null : { payload: result.payload, droppedFacts: [] };
    },
    createNode: async (storyId: string, body: CreateNodeRequest) => {
      createNodeCalls.push({ storyId, body });
      if (overrides.createNode === undefined) throw new Error("unexpected call: createNode");
      return overrides.createNode(storyId, body);
    },
    editNode: async (storyId: string, node: StoryNode, patch: { instruction?: string; text?: string }) => {
      editNodeCalls.push({ storyId, node, patch });
      if (overrides.editNode === undefined) throw new Error("unexpected call: editNode");
      return overrides.editNode(storyId, node, patch);
    },
    deleteNode: async (storyId: string, nodeId: string, count: number) => {
      deleteNodeCalls.push({ storyId, nodeId, count });
      if (overrides.deleteNode === undefined) throw new Error("unexpected call: deleteNode");
      return overrides.deleteNode(storyId, nodeId, count);
    },
    loadStory: async (id: string) => {
      loadStoryCalls.push(id);
      if (overrides.loadStory === undefined) throw new Error("unexpected call: loadStory");
      return overrides.loadStory(id);
    },
    getTakeLine: async (storyId: string, nodeId: string) => {
      if (overrides.getTakeLine === undefined) throw new Error("unexpected call: getTakeLine");
      return overrides.getTakeLine(storyId, nodeId);
    }
  };

  for (const [name, method] of Object.entries(overrides.methods ?? {})) implemented[name] = method;

  // The one cast in the file: a `StoryApi` has about a hundred methods, and a
  // test must not have to name them. A Proxy answers every name, so the type
  // is complete in fact, not only in appearance.
  const api = new Proxy({}, {
    get: (_target, name) => {
      // Never `then`: an awaited api must not look like a promise.
      if (typeof name !== "string" || name === "then") return undefined;
      return (...args: never[]) => {
        calls.push(name);
        const method = implemented[name];
        if (method === undefined) return Promise.reject(new Error(`unexpected call: ${name}`));
        return method(...args);
      };
    }
  }) as StoryApi;

  return {
    api, continueCalls, createNodeCalls, editNodeCalls, deleteNodeCalls, loadStoryCalls, calls,
    setContinueStory: (run) => { continueRun = run; }
  };
}

/** The real app actions over `store`, with a manual flush scheduler so a
 * test decides when streamed text becomes visible. */
export function createActionsForStore(store: Store<AppState>): {
  readonly actions: ContentActions;
  readonly scheduler: { current: ManualFlushScheduler | null };
} {
  const scheduler: { current: ManualFlushScheduler | null } = { current: null };
  const actions = createContentActions(store, {
    createScheduler: () => {
      scheduler.current = createManualFlushScheduler();
      return scheduler.current;
    }
  });
  return { actions, scheduler };
}
