import {
  startPromptTokenCountLane,
  type PromptTokenCountHost,
  type PromptTokenCountLane
} from "../../../shared/prompt-token-count-lane.js";
import { nextRequestEstimate, type NextRequestContext } from "../../../shared/request-projection.js";
import { estimateResponseGrowthTokens } from "../../../shared/response-growth-estimate.js";
import { deriveContinuationRuntime, generationRouteKey } from "../../../shared/runtime-settings.js";
import type { StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import { isGenerationActive } from "../generation/state.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { composeDraftOf } from "../compose/state.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { promptFingerprint } from "./fingerprint.js";
import type { ContextRuntime, ProjectionSnapshot } from "./state.js";

/** A typed direction is projected this long after the last keystroke, so
 * typing never recomputes the request per key. */
const TYPING_SETTLE_MS = 250;

export interface ContextActions {
  /** Starts following the store; returns the disposer. */
  readonly start: () => () => void;
  readonly toggleExpanded: () => void;
  readonly setExpanded: (expanded: boolean) => void;
}

/** What the projection is built from. Two equal inputs give the same request. */
interface Inputs {
  readonly storyId: string;
  readonly payload: StoryPayload;
  readonly targetId: string | null;
  readonly retakeId: string | null;
  readonly instruction: string;
  readonly runtime: ContextRuntime;
}

function sameStructure(left: Inputs, right: Inputs): boolean {
  return left.storyId === right.storyId
    && left.payload === right.payload
    && left.targetId === right.targetId
    && left.retakeId === right.retakeId
    && left.runtime === right.runtime;
}

function readInputs(state: AppState): Inputs | null {
  const { route, story, context } = state;
  if (route.kind !== "story" || story.kind !== "loaded" || story.payload.id !== route.id || context.runtime === null) return null;
  const draft = composeDraftOf(state.compose, route.id);
  const retake = draft.retake !== null && story.payload.path.some((node) => node.id === draft.retake?.nodeId)
    ? draft.retake
    : null;
  return {
    storyId: route.id,
    payload: story.payload,
    targetId: effectiveFocusedPartId(story),
    retakeId: retake?.nodeId ?? null,
    instruction: retake === null ? draft.direct : retake.text,
    runtime: context.runtime
  };
}

/** The next request as Continue (or a retake) would send it: the same
 * `continuationIntent` the send uses, and the same estimate the TUI meter reads. */
function project(inputs: Inputs): ProjectionSnapshot {
  const { runtime } = inputs.runtime;
  const base = {
    systemPrompt: runtime.systemPrompt,
    defaultContinueDirection: runtime.activeWriting.defaultContinueDirection,
    instruction: inputs.instruction,
    assistantPrefill: runtime.assistantPrefill,
    continuationPromptLayout: runtime.continuationPromptLayout,
    contextWindow: runtime.contextWindow,
    maxTokens: runtime.maxTokens,
    remoteModelId: runtime.model
  };
  const lastId = inputs.payload.path.at(-1)?.id ?? null;
  const context: NextRequestContext = inputs.retakeId !== null
    ? { ...base, operation: "retake", targetId: inputs.retakeId }
    : { ...base, operation: "continue", targetId: inputs.targetId ?? lastId };
  const estimate = nextRequestEstimate(inputs.payload, context);
  return {
    storyId: inputs.storyId,
    estimate,
    growthTokens: estimateResponseGrowthTokens({
      payload: inputs.payload,
      maxOutputTokens: runtime.maxTokens,
      requestTokens: estimate.tokens,
      contextWindow: runtime.contextWindow
    }),
    contextWindow: runtime.contextWindow,
    maxOutputTokens: runtime.maxTokens,
    fingerprint: promptFingerprint(estimate.messages, inputs.runtime.route)
  };
}

export function createContextActions(store: Store<AppState>): ContextActions {
  const patch = (change: (state: AppState["context"]) => AppState["context"]): void => {
    store.set((state) => {
      const next = change(state.context);
      return next === state.context ? state : { ...state, context: next };
    });
  };

  /** Provider work owns the prompt: a stream, a summary, an Aside answer, or a story name. */
  const providerBusy = (state: AppState): boolean =>
    isGenerationActive(state.generation) || state.chapters.summaryRun !== null || state.aside.run !== null
    || state.notes.naming !== null;

  const host: PromptTokenCountHost<string> = {
    storyId: () => store.get().context.projection?.storyId ?? "",
    route: () => store.get().context.runtime?.route ?? "",
    providerBusy: () => providerBusy(store.get()),
    requestViewerOpen: () => false,
    project: () => {
      const projection = store.get().context.projection;
      return {
        messages: projection?.estimate.messages ?? [],
        identity: projection?.fingerprint ?? ""
      };
    },
    hasAnswer: () => store.get().context.count !== null,
    setAnswer: (answer) => patch((context) => ({ ...context, count: answer })),
    repaint: () => {}
  };

  let lane: PromptTokenCountLane | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let settled: Inputs | null = null;
  let lastConnection: unknown = null;
  let lastRouteStory: string | null = null;
  let lastBusy = false;
  let runtimeTicket = 0;

  const clearTyping = (): void => {
    if (typingTimer !== null) clearTimeout(typingTimer);
    typingTimer = null;
  };

  /** Reads the settings the projection needs. A failure leaves the meter as it was. */
  async function refreshRuntime(): Promise<void> {
    const connection = store.get().connection;
    if (connection.kind !== "connected") return;
    const ticket = ++runtimeTicket;
    try {
      const view = await retryWhenBusy(() => connection.api.getSettings());
      if (ticket !== runtimeTicket) return;
      const runtime = deriveContinuationRuntime(view, false);
      const route = generationRouteKey(view.effectiveProse);
      patch((context) => {
        const previous = context.runtime;
        // The same settings keep the same object, so nothing is projected again.
        if (previous !== null && previous.route === route && JSON.stringify(previous.runtime) === JSON.stringify(runtime)) {
          return context;
        }
        return { ...context, runtime: { runtime, route } };
      });
    } catch {
      // A failed read keeps what the meter had.
    }
  }

  /** Projects the settled inputs (once per distinct input) and tells the lane. */
  function settle(): void {
    clearTyping();
    const state = store.get();
    const busy = providerBusy(state);
    // Set before the store changes: the change calls back into `onStoreChange`.
    lastBusy = busy;
    if (!busy) {
      const inputs = readInputs(state);
      if (inputs !== null) {
        settled = inputs;
        patch((context) => ({ ...context, projection: project(inputs) }));
      }
    }
    lane?.notify();
  }

  const onStoreChange = (): void => {
    const state = store.get();
    // A new connection or a new story reads the settings again: the writer may
    // have changed them in Settings or in another tab since.
    const routeStory = state.route.kind === "story" ? state.route.id : null;
    if (state.connection.kind === "connected" && routeStory !== null
      && (state.connection !== lastConnection || routeStory !== lastRouteStory)) {
      lastConnection = state.connection;
      lastRouteStory = routeStory;
      void refreshRuntime();
    }
    if (routeStory === null) lastRouteStory = null;

    const busy = providerBusy(state);
    if (busy !== lastBusy) {
      settle();
      return;
    }
    if (busy) return;
    const inputs = readInputs(state);
    if (inputs === null) return;
    if (settled === null || !sameStructure(settled, inputs)) {
      settle();
      return;
    }
    // Only the typed direction moved: wait for a pause.
    clearTyping();
    if (settled.instruction !== inputs.instruction) typingTimer = setTimeout(settle, TYPING_SETTLE_MS);
  };

  return {
    start: () => {
      lane = startPromptTokenCountLane({
        host,
        api: {
          countPromptTokens: (messages, signal) => {
            const connection = store.get().connection;
            if (connection.kind !== "connected") return Promise.reject(new Error("1667 web: not connected"));
            return connection.api.countPromptTokens(messages, signal);
          }
        },
        fingerprint: promptFingerprint,
        debounceMs: 0
      });
      const unsubscribe = store.subscribe(onStoreChange);
      onStoreChange();
      return () => {
        unsubscribe();
        clearTyping();
        lane?.dispose();
        lane = null;
      };
    },
    toggleExpanded: () => patch((context) => ({ ...context, expanded: !context.expanded })),
    setExpanded: (expanded) => patch((context) => (context.expanded === expanded ? context : { ...context, expanded }))
  };
}
