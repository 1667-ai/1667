import { ApiFailureError, apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import type { StoryPayload } from "../../../shared/types.js";
import { isTimeoutClassFailure } from "../../../shared/failure-envelope.js";
import type { AppState } from "../app/state.js";
import type { ConnectionState } from "../app/connection.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { WebBridgeTransportError } from "../../../client/web-bridge-transport.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { planContinue } from "./plan.js";
import {
  appendBufferReasoning,
  appendBufferText,
  createRafFlushScheduler,
  createStreamBuffer,
  hasSubstantiveText,
  type FlushScheduler,
  type StreamBuffer
} from "./stream-buffer.js";
import { saveStopped, type StopSaveOutcome } from "./settle.js";
import type { GenerationMode } from "./state.js";

/** Step-6 seam: `instruction` and `draft` are both accepted here so the
 * composer (step 6) can add a typed direction and a restorable draft
 * without changing this signature again. Step 5 never passes either — every
 * caller here (`GenerationBar`'s Continue button, the Space key) calls
 * `continue()` with no argument at all. */
export interface GenerationContinueRequest {
  readonly instruction?: string;
  readonly draft?: { restore(): void; clear(): void };
}

export interface GenerationActions {
  continue(request?: GenerationContinueRequest): Promise<void>;
  stop(): void;
  /** Re-attempts the commit for the current `"unsaved"` generation, over
   * whichever connection is live right now (not necessarily the one that
   * started the run — decision 3's "no auto-save after reconnect" is about
   * automatic retries; a writer explicitly asking again is the exception). */
  retrySave(): Promise<void>;
  discardUnsaved(): void;
  copyUnsaved(): Promise<void>;
}

export interface GenerationActionDependencies {
  /** `story/actions.ts`'s public `adoptPayload` — see its own doc for the
   * version guard, the route gate, and the focus/announcement contract this
   * module relies on. */
  readonly adoptPayload: StoryAdoptPayload;
  /** Overrides the flush scheduler a run uses — the integration test
   * supplies a manually-driven fake; every real caller (`app/actions.ts`)
   * omits this and gets one real `requestAnimationFrame`-backed scheduler
   * per run. */
  readonly createScheduler?: () => FlushScheduler;
}

type StoryAdoptPayload = (
  storyId: string,
  payload: StoryPayload,
  options?: { readonly focusNewLeafIf?: string | null; readonly announcement?: string }
) => boolean;

type Connected = Extract<ConnectionState, { kind: "connected" }>;

/** Everything a run needs across its whole lifetime, from the moment
 * `continue()` admits it to the moment it either lands, is discarded, or is
 * replaced. Lives only in this factory's closure — never in the store — so
 * a stale connection or a superseded run can never be reconstructed from
 * what a component reads. Stays around (in the `"unsaved"` phase) after a
 * failed save, so `retrySave`/`discardUnsaved`/`copyUnsaved` have something
 * to act on; only ever cleared by `setIdle`. */
interface ActiveRun {
  readonly genId: string;
  readonly storyId: string;
  readonly storyTitle: string;
  readonly mode: GenerationMode;
  readonly appendTo: string | null;
  readonly parentId: string | null;
  readonly expectedTextHash: string | undefined;
  readonly seamPathIndex: number;
  readonly instruction: string;
  readonly focusAtStart: string | null;
  readonly controller: AbortController;
  /** The connection this run started on — `api` is a fixed reference into
   * it. A later reconnect replaces `state.connection` with a new object, so
   * `connectionCurrent` (reference equality) is how every live callback
   * (`onDelta`/`onReasoning`) tells a still-current connection from a stale
   * one without re-deriving it from the store each time. */
  readonly connection: Connected;
  readonly api: StoryApi;
  readonly buffer: StreamBuffer;
  readonly scheduler: FlushScheduler;
  stopRequested: boolean;
}

export function createGenerationActions(
  store: Store<AppState>,
  deps: GenerationActionDependencies
): GenerationActions {
  let activeRun: ActiveRun | null = null;

  const isCurrentRun = (run: ActiveRun): boolean => activeRun === run;
  const connectionCurrent = (run: ActiveRun): boolean => store.get().connection === run.connection;

  function setIdle(): void {
    activeRun = null;
    store.set((state) => (state.generation.kind === "idle" ? state : { ...state, generation: { kind: "idle" } }));
  }

  /** Projects a run's current phase (and, for `running`/`settling`, its
   * buffered text) into the store — every transition below goes through
   * this so the shape written always matches `GenerationState` exactly. */
  function publish(run: ActiveRun, kind: "running" | "settling"): void {
    store.set((state) => ({
      ...state,
      generation: {
        kind,
        genId: run.genId,
        storyId: run.storyId,
        storyTitle: run.storyTitle,
        mode: run.mode,
        appendTo: run.appendTo,
        parentId: run.parentId,
        seamPathIndex: run.seamPathIndex,
        instruction: run.instruction,
        text: run.buffer.text,
        reasoning: run.buffer.reasoning,
        focusAtStart: run.focusAtStart,
        stopRequested: run.stopRequested
      }
    }));
  }

  function publishUnsaved(run: ActiveRun, message: string): void {
    store.set((state) => ({
      ...state,
      generation: {
        kind: "unsaved",
        genId: run.genId,
        storyId: run.storyId,
        storyTitle: run.storyTitle,
        mode: run.mode,
        appendTo: run.appendTo,
        parentId: run.parentId,
        seamPathIndex: run.seamPathIndex,
        instruction: run.instruction,
        text: run.buffer.text,
        reasoning: run.buffer.reasoning,
        focusAtStart: run.focusAtStart,
        message
      }
    }));
  }

  /** Schedules (at most once per animation frame) a store write of the
   * buffer's current text/reasoning. The buffer itself is always updated
   * synchronously in the caller before this is scheduled — this only
   * throttles *presentation*, so a paused rAF in a hidden tab can never
   * cause a lost delta, only a delayed repaint. */
  function scheduleFlush(run: ActiveRun): void {
    run.scheduler.schedule(() => {
      if (!isCurrentRun(run)) return;
      store.set((state) => {
        if (state.generation.kind === "idle" || state.generation.genId !== run.genId) return state;
        return {
          ...state,
          generation: { ...state.generation, text: run.buffer.text, reasoning: run.buffer.reasoning }
        };
      });
    });
  }

  function partNumberOf(payload: StoryPayload): number {
    return payload.path.length;
  }

  /** The one place a run's outcome (from `saveStopped`, whether reached via
   * a Stop or a timeout-class failure) is turned into a store update and a
   * toast/announcement — shared by the initial settle and by `retrySave`, so
   * both agree on exactly what "saved", "not-substantive", and "failed"
   * each do. `failureMessage` is non-null only for a timeout-class (or
   * connection-loss) failure driving this settle, never for a plain
   * writer-initiated Stop. */
  function applyOutcome(run: ActiveRun, outcome: StopSaveOutcome, failureMessage: string | null): void {
    if (!isCurrentRun(run)) return;
    if (outcome.kind === "saved") {
      const n = partNumberOf(outcome.payload);
      const applied = deps.adoptPayload(run.storyId, outcome.payload, {
        focusNewLeafIf: run.focusAtStart,
        announcement: `Stopped. Part ${n} kept.`
      });
      setIdle();
      if (failureMessage !== null) {
        pushToast(store, `${failureMessage} · generation stopped · text kept in ${run.storyTitle}.`);
      } else if (!applied) {
        pushToast(store, `Stopped writing in ${run.storyTitle}. Text kept.`);
      }
      return;
    }
    if (outcome.kind === "not-substantive") {
      deps.adoptPayload(run.storyId, outcome.payload, { announcement: "Stopped. Nothing was written." });
      setIdle();
      if (failureMessage !== null) pushToast(store, failureMessage);
      return;
    }
    // "failed": the commit itself did not go through. Refresh what we can
    // from the best-effort reload, but keep the buffered text visible and
    // reachable (Copy/Discard) rather than lose it — decision 3, generalized
    // from "connection lost" to any commit failure, timeout-class or not.
    if (outcome.payload !== null) deps.adoptPayload(run.storyId, outcome.payload);
    publishUnsaved(run, errorMessage(outcome.error));
    pushToast(store, `Not saved: ${errorMessage(outcome.error)}`);
  }

  async function settleStopped(run: ActiveRun, failureMessage: string | null): Promise<void> {
    publish(run, "settling");
    const outcome = await saveStopped(run.api, {
      storyId: run.storyId,
      genId: run.genId,
      mode: run.mode,
      appendTo: run.appendTo,
      expectedTextHash: run.expectedTextHash,
      parentId: run.parentId,
      instruction: run.instruction,
      text: run.buffer.text
    });
    applyOutcome(run, outcome, failureMessage);
  }

  async function finishRun(
    run: ActiveRun,
    result: { readonly payload: StoryPayload } | null,
    error: unknown
  ): Promise<void> {
    if (!isCurrentRun(run)) return;
    run.scheduler.cancel();

    if (result !== null) {
      // The model finished, whether or not a Stop was also requested in the
      // meantime — an in-flight Stop that loses the race to a real result is
      // still a success: adopt it, and never fall through to a createNode
      // save (that would risk a duplicate part under a second, different id).
      const n = partNumberOf(result.payload);
      const applied = deps.adoptPayload(run.storyId, result.payload, {
        focusNewLeafIf: run.focusAtStart,
        announcement: `Part ${n} written.`
      });
      setIdle();
      if (!applied) pushToast(store, `Part ${n} written in ${run.storyTitle}.`);
      return;
    }

    if (run.stopRequested) {
      await settleStopped(run, null);
      return;
    }

    if (apiErrorCode(error) === "resource_busy") {
      setIdle();
      pushToast(store, "Another window is writing in this story.");
      return;
    }

    const apiFailure = error instanceof ApiFailureError ? error : null;
    const timeoutClass = apiFailure !== null && isTimeoutClassFailure(apiFailure.failure);
    // Anything that is not a structured API failure at all (the transport
    // closed, the socket dropped) carries no server verdict on the prose
    // already streamed — decision 3 treats it the same as a clean timeout,
    // never as a rejection, so it is never silently discarded.
    const connectionFailure = apiFailure === null;
    if (hasSubstantiveText(run.buffer.text) && (timeoutClass || connectionFailure)) {
      await settleStopped(run, errorMessage(error));
      return;
    }

    // A genuine provider/validation rejection: committing this prose would
    // durably save output the server refused, so it is discarded, matching
    // the TUI's own `generate()` exactly (see its `isTimeoutClassApiFailure`
    // doc for the full reasoning).
    setIdle();
    if (error instanceof WebBridgeTransportError && error.mutationOutcome === "uncertain") {
      try {
        const payload = await run.api.loadStory(run.storyId);
        deps.adoptPayload(run.storyId, payload);
      } catch {
        // Best effort only — the writer still gets the failure toast below.
      }
    }
    pushToast(store, errorMessage(error));
  }

  return {
    continue: async (request = {}) => {
      if (activeRun !== null) return;
      const state = store.get();
      if (state.connection.kind !== "connected") return;
      if (state.route.kind !== "story") return;
      const story = state.story;
      if (story.kind !== "loaded" || story.payload.id !== state.route.id) return;
      const connection = state.connection;
      const storyId = story.payload.id;
      const storyTitle = story.payload.title;
      const focusedPartId = effectiveFocusedPartId(story);

      const requestedInstruction = request.instruction ?? "";
      const plan = await planContinue(story.payload, focusedPartId, requestedInstruction);
      // Re-validated after the await (`textHash` yields): a reconnect or a
      // second admission racing this one must not both proceed.
      if (activeRun !== null || store.get().connection !== connection) return;

      const genId = crypto.randomUUID();
      const controller = new AbortController();
      const run: ActiveRun = {
        genId,
        storyId,
        storyTitle,
        mode: plan.mode,
        appendTo: plan.appendTo,
        parentId: plan.parentId,
        expectedTextHash: plan.expectedTextHash,
        seamPathIndex: plan.seamPathIndex,
        instruction: plan.instruction,
        focusAtStart: focusedPartId,
        controller,
        connection,
        api: connection.api,
        buffer: createStreamBuffer(),
        scheduler: (deps.createScheduler ?? createRafFlushScheduler)(),
        stopRequested: false
      };
      activeRun = run;
      publish(run, "running");

      const target = plan.mode === "append"
        ? { appendTo: plan.appendTo!, expectedTextHash: plan.expectedTextHash! }
        : { parentId: plan.parentId };

      try {
        // Idempotent by `genId`: a `resource_busy` admission refusal (another
        // claim briefly held the story) is safe to retry whole, since it can
        // only ever happen before any provider work — and so before any
        // delta — starts.
        // The raw, unresolved instruction — never `plan.instruction` (that is
        // the resolved default the SAVE path records; the server resolves
        // the same default itself when it builds the prompt, so the wire
        // request always carries exactly what the writer typed).
        const result = await retryWhenBusy(() => run.api.continueStory(
          storyId,
          requestedInstruction,
          genId,
          target,
          (delta) => {
            if (!isCurrentRun(run) || !connectionCurrent(run)) return;
            appendBufferText(run.buffer, delta);
            scheduleFlush(run);
          },
          controller.signal,
          {
            // Delivered once, at terminal settlement, for text that arrived
            // after Stop — must always land in the authoritative buffer
            // regardless of `connectionCurrent`, because the save below
            // reads only this buffer, never the store's presented copy.
            onStopped: (tail) => {
              if (!isCurrentRun(run)) return;
              appendBufferText(run.buffer, tail);
            },
            onReasoning: (delta) => {
              if (!isCurrentRun(run) || !connectionCurrent(run)) return;
              appendBufferReasoning(run.buffer, delta.text, delta.tokenCount);
              scheduleFlush(run);
            },
            onReasoningStopped: (tail) => {
              if (!isCurrentRun(run)) return;
              appendBufferReasoning(run.buffer, tail, run.buffer.reasoning?.tokenCount ?? 0);
            }
          }
        ));
        await finishRun(run, result, null);
      } catch (error) {
        await finishRun(run, null, error);
      }
    },

    stop: () => {
      const run = activeRun;
      if (run === null || run.stopRequested) return;
      run.stopRequested = true;
      // Immediate UI feedback (the bar flips to disabled "Saving…" the
      // instant Stop is pressed) — `settleStopped` re-publishes the same
      // phase once the transport actually settles, which is a harmless
      // no-op re-affirmation on this path.
      publish(run, "settling");
      run.controller.abort();
    },

    retrySave: async () => {
      const run = activeRun;
      const state = store.get();
      if (run === null || state.generation.kind !== "unsaved" || state.generation.genId !== run.genId) return;
      // Retry over whichever connection is live right now, not necessarily
      // the one the run started on — the point of an explicit retry is that
      // the original may already be dead.
      const api = state.connection.kind === "connected" ? state.connection.api : run.api;
      publish(run, "settling");
      const outcome = await saveStopped(api, {
        storyId: run.storyId,
        genId: run.genId,
        mode: run.mode,
        appendTo: run.appendTo,
        expectedTextHash: run.expectedTextHash,
        parentId: run.parentId,
        instruction: run.instruction,
        text: run.buffer.text
      });
      applyOutcome(run, outcome, null);
    },

    discardUnsaved: () => {
      const state = store.get();
      if (state.generation.kind !== "unsaved") return;
      setIdle();
    },

    copyUnsaved: async () => {
      const state = store.get();
      if (state.generation.kind !== "unsaved") return;
      try {
        await navigator.clipboard.writeText(state.generation.text);
      } catch {
        pushToast(store, "Could not copy the text. Select it and copy it by hand.");
      }
    }
  };
}
