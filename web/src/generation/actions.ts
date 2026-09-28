import { apiErrorCode } from "../../../client/api-error.js";
import type { ContinueTarget, StoryApi } from "../../../client/api.js";
import type { StoryPayload } from "../../../shared/types.js";
import { stoppedTextDisposition, type GenerationTarget } from "../../../shared/stopped-generation.js";
import type { AppState } from "../app/state.js";
import type { ConnectionState } from "../app/connection.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { WebBridgeTransportError } from "../../../client/web-bridge-transport.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { STORY_LOCKED_TOAST, STORY_RELOADED_TOAST } from "../story/actions.js";
import { planContinue } from "./plan.js";
import type { GenerationState } from "./state.js";
import {
  appendBufferReasoning,
  appendBufferText,
  createRafFlushScheduler,
  createStreamBuffer,
  type FlushScheduler,
  type StreamBuffer
} from "./stream-buffer.js";
import { saveStopped, type StopSaveOutcome, type StopSaveRequest } from "./settle.js";

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
  /** Owns the "already writing" refusal and its toast (review fix #9) —
   *  every caller (the Space key, `GenerationBar`'s Continue button, and
   *  step 6's composer submit) just calls this unconditionally; none of them
   *  needs its own copy of the busy check or the exact wording. */
  continue(request?: GenerationContinueRequest): Promise<void>;
  /** Returns whether it actually stopped a running generation — `false` when
   *  there was nothing to stop (idle, already settling/unsaved). `app/
   *  keymap.ts`'s global Escape handler uses this to decide whether it, and
   *  not some other Escape-consumer (a popover closing), owns the key. */
  stop(): boolean;
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
 * to act on; only ever cleared by `setIdle`.
 *
 * `phase` is the one source of truth for where this run is (review fix #6):
 * `project()` below is a pure read of it (plus the buffer), and every action
 * guards on it directly instead of cross-checking the store's own
 * `generation.kind`. There is no separate `stopRequested` flag — `stop()`
 * moves `phase` to `"settling"` itself, and `finishRun` reads that same
 * field to tell "the writer asked to stop" from "the model simply failed". */
interface ActiveRun {
  readonly genId: string;
  readonly storyId: string;
  readonly storyTitle: string;
  readonly target: GenerationTarget;
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
  phase: "running" | "settling" | "unsaved";
  /** Set only once `phase` is `"unsaved"` — the message the card shows. */
  message: string;
}

function continueTargetOf(target: GenerationTarget): ContinueTarget {
  return target.mode === "append"
    ? { appendTo: target.appendTo, expectedTextHash: target.expectedTextHash }
    : { parentId: target.parentId };
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

  /** The one place a run's `phase` (and its buffered text) becomes a
   * `GenerationState` — a pure read of `run`, never a decision of its own
   * (review fix #6: replaces the near-duplicate `publish`/`publishUnsaved`
   * pair, which built the same object twice with almost the same fields). */
  function project(run: ActiveRun): GenerationState {
    const target = run.target;
    const shared = {
      genId: run.genId,
      storyId: run.storyId,
      storyTitle: run.storyTitle,
      mode: target.mode,
      appendTo: target.mode === "append" ? target.appendTo : null,
      parentId: target.mode === "take" ? target.parentId : null,
      seamPathIndex: run.seamPathIndex,
      instruction: run.instruction,
      text: run.buffer.text,
      reasoning: run.buffer.reasoning,
      focusAtStart: run.focusAtStart
    };
    if (run.phase === "unsaved") return { ...shared, kind: "unsaved", message: run.message };
    return { ...shared, kind: run.phase };
  }

  function publish(run: ActiveRun): void {
    store.set((state) => ({ ...state, generation: project(run) }));
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

  function saveRequestOf(run: ActiveRun): StopSaveRequest {
    return {
      storyId: run.storyId,
      genId: run.genId,
      target: run.target,
      instruction: run.instruction,
      text: run.buffer.text
    };
  }

  /** Best-effort reload+adopt, swallowing its own failure — used wherever a
   * failure leaves the cached story possibly stale but there is no buffered
   * text to protect (an admission-time `revision_conflict`, or an
   * `"uncertain"` mutation outcome). Never throws; the caller's own toast is
   * shown regardless of whether this succeeds. */
  async function reloadBestEffort(run: ActiveRun): Promise<void> {
    try {
      const payload = await run.api.loadStory(run.storyId);
      deps.adoptPayload(run.storyId, payload);
    } catch {
      // Best effort only.
    }
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
    run.phase = "unsaved";
    run.message = errorMessage(outcome.error);
    publish(run);
    pushToast(store, `Not saved: ${run.message}`);
  }

  async function settleStopped(run: ActiveRun, failureMessage: string | null): Promise<void> {
    run.phase = "settling";
    publish(run);
    const outcome = await saveStopped(run.api, saveRequestOf(run));
    applyOutcome(run, outcome, failureMessage);
  }

  function refuseAlreadyWriting(state: AppState): void {
    const generation = state.generation;
    if (generation.kind === "idle") return;
    const inThisStory = state.route.kind === "story" && state.route.id === generation.storyId;
    pushToast(store, inThisStory ? STORY_LOCKED_TOAST : `Already writing in ${generation.storyTitle}. Esc stops it.`);
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

    if (run.phase === "settling") {
      // `stop()` already moved this run here before the transport settled.
      await settleStopped(run, null);
      return;
    }

    const code = apiErrorCode(error);
    if (code === "resource_busy") {
      setIdle();
      pushToast(store, "Another window is writing in this story.");
      return;
    }
    if (code === "revision_conflict") {
      // Continue's own admission was refused because this run's plan was
      // built against a payload that has since moved — every retry would
      // repeat the same conflict until the cache is refreshed (review fix
      // #2). No text has streamed yet at this point (admission is checked
      // before any provider work starts), so there is nothing to protect;
      // only the stale cache needs fixing before the writer's next attempt
      // can land.
      setIdle();
      await reloadBestEffort(run);
      pushToast(store, STORY_RELOADED_TOAST);
      return;
    }

    const disposition = stoppedTextDisposition(error);
    if (disposition === "save") {
      await settleStopped(run, errorMessage(error));
      return;
    }
    if (disposition === "keep-unsaved" && run.buffer.text.trim().length > 0) {
      // The connection itself is gone (not a structured API failure at
      // all) — a save attempt right now would fail immediately too (review
      // fix #5, web-only: the TUI treats this exactly like a discard — see
      // `stoppedTextDisposition`'s own doc). Show the same "Not saved" card
      // a failed save leaves behind, rather than attempting a commit that
      // cannot succeed or silently losing real prose.
      run.phase = "unsaved";
      run.message = errorMessage(error);
      publish(run);
      pushToast(store, `Not saved: ${run.message}`);
      return;
    }

    // A genuine provider/validation rejection (or a connection loss with
    // nothing substantive to keep): committing this prose would durably save
    // output the server refused, so it is discarded.
    setIdle();
    if (error instanceof WebBridgeTransportError && error.mutationOutcome === "uncertain") {
      await reloadBestEffort(run);
    }
    pushToast(store, errorMessage(error));
  }

  return {
    continue: async (request = {}) => {
      if (activeRun !== null) {
        refuseAlreadyWriting(store.get());
        return;
      }
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
      if (activeRun !== null) {
        refuseAlreadyWriting(store.get());
        return;
      }
      if (store.get().connection !== connection) return;

      const genId = crypto.randomUUID();
      const controller = new AbortController();
      const run: ActiveRun = {
        genId,
        storyId,
        storyTitle,
        target: plan.target,
        seamPathIndex: plan.seamPathIndex,
        instruction: plan.instruction,
        focusAtStart: focusedPartId,
        controller,
        connection,
        api: connection.api,
        buffer: createStreamBuffer(),
        scheduler: (deps.createScheduler ?? createRafFlushScheduler)(),
        phase: "running",
        message: ""
      };
      activeRun = run;
      publish(run);

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
          continueTargetOf(run.target),
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
      if (run === null || run.phase !== "running") return false;
      run.phase = "settling";
      // Immediate UI feedback (the bar flips to disabled "Saving…" the
      // instant Stop is pressed) — `settleStopped` re-publishes the same
      // phase once the transport actually settles, which is a harmless
      // no-op re-affirmation on this path.
      publish(run);
      run.controller.abort();
      return true;
    },

    retrySave: async () => {
      const run = activeRun;
      if (run === null || run.phase !== "unsaved") return;
      // Retry over whichever connection is live right now, not necessarily
      // the one the run started on — the point of an explicit retry is that
      // the original may already be dead.
      const state = store.get();
      const api = state.connection.kind === "connected" ? state.connection.api : run.api;
      run.phase = "settling";
      publish(run);
      const outcome = await saveStopped(api, saveRequestOf(run));
      applyOutcome(run, outcome, null);
    },

    discardUnsaved: () => {
      if (activeRun === null || activeRun.phase !== "unsaved") return;
      setIdle();
    },

    copyUnsaved: async () => {
      const run = activeRun;
      if (run === null || run.phase !== "unsaved") return;
      try {
        await navigator.clipboard.writeText(run.buffer.text);
      } catch {
        pushToast(store, "Could not copy the text. Select it and copy it by hand.");
      }
    }
  };
}
