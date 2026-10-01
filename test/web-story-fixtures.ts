import type { ContinueTarget, StoryApi, StreamCallbacks } from "../client/api.js";
import { ApiFailureError } from "../client/api-error.js";
import type { WebBridgeTransport } from "../client/web-bridge-transport.js";
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

function stub(id: string, parentId: string | null, text: string): NodeStub {
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

export function connectedState(api: Partial<StoryApi>): ConnectionState {
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
  readonly defaultContinueDirection?: string;
}

export interface FakeApi {
  readonly api: Partial<StoryApi>;
  readonly continueCalls: ContinueCall[];
  readonly createNodeCalls: { readonly storyId: string; readonly body: CreateNodeRequest }[];
  readonly editNodeCalls: {
    readonly storyId: string;
    readonly node: StoryNode;
    readonly patch: { instruction?: string; text?: string };
  }[];
  readonly deleteNodeCalls: { readonly storyId: string; readonly nodeId: string; readonly count: number }[];
  readonly loadStoryCalls: string[];
}

/** Records every call. Anything not overridden succeeds trivially. */
export function fakeApi(overrides: FakeApiOptions = {}): FakeApi {
  const continueCalls: ContinueCall[] = [];
  const createNodeCalls: FakeApi["createNodeCalls"] = [];
  const editNodeCalls: FakeApi["editNodeCalls"] = [];
  const deleteNodeCalls: FakeApi["deleteNodeCalls"] = [];
  const loadStoryCalls: string[] = [];
  const api: Partial<StoryApi> = {
    continueStory: async (storyId, instruction, genId, target, onDelta, signal, callbacks = {}) => {
      continueCalls.push({ storyId, instruction, genId, target, onDelta, signal, callbacks });
      const run = overrides.continueStory
        ?? (() => Promise.resolve({ payload: linearPayload(["a1", "a2"]) }));
      const result = await run(storyId, instruction, genId, target, onDelta, signal, callbacks);
      return result === null ? null : { payload: result.payload, droppedFacts: [] };
    },
    createNode: async (storyId, body) => {
      createNodeCalls.push({ storyId, body });
      if (overrides.createNode !== undefined) return overrides.createNode(storyId, body);
      return linearPayload(["a1", "a2"]);
    },
    editNode: async (storyId, node, patch) => {
      editNodeCalls.push({ storyId, node, patch });
      if (overrides.editNode !== undefined) return overrides.editNode(storyId, node, patch);
      return linearPayload(["a1", "a2"]);
    },
    deleteNode: async (storyId, nodeId, count) => {
      deleteNodeCalls.push({ storyId, nodeId, count });
      if (overrides.deleteNode !== undefined) return overrides.deleteNode(storyId, nodeId, count);
      return linearPayload(["a1"]);
    },
    listStories: async () => [],
    getSettings: async () => {
      if (overrides.defaultContinueDirection === undefined) throw new Error("no settings in this fake");
      return { activeWriting: { defaultContinueDirection: overrides.defaultContinueDirection } } as never;
    },
    loadStory: async (id) => {
      loadStoryCalls.push(id);
      if (overrides.loadStory !== undefined) return overrides.loadStory(id);
      return linearPayload(["a1"]);
    }
  };
  return { api, continueCalls, createNodeCalls, editNodeCalls, deleteNodeCalls, loadStoryCalls };
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
