import { apiErrorCode } from "../../../client/api-error.js";
import type { ContinueTarget, StoryApi } from "../../../client/api.js";
import type { StoryNode, StoryPayload } from "../../../shared/types.js";
import { stoppedTextDisposition, type GenerationTarget } from "../../../shared/stopped-generation.js";
import type { AppState } from "../app/state.js";
import type { ConnectionState } from "../app/connection.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import { WebBridgeTransportError } from "../../../client/web-bridge-transport.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { STORY_RELOADED_TOAST, type AdoptFocus } from "../story/actions.js";
import { RETAKE_GONE_TOAST, STORY_LOCKED_TOAST, generationBusyToast, generationEditorRefusal, planEditorRefusal } from "../story/part-policy.js";
import { planContinue, type GenerationPlan } from "./plan.js";
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

/** What a composer submit hands back to the writer's draft once a run ends.
 * `restore` puts the submitted text back where it was typed (only if the
 * writer has not typed something newer there); `clear` drops it after the
 * take landed. `generation/actions.ts` calls each through `settleDraft`, so a
 * handle is never called twice for one meaning and never throws into a run.
 * Built by `compose/draft-handle.ts`. */
export interface DraftHandle {
  /** Puts the text back. Returns whether it did: a newer text in the box, or
   * a box that was already restored, means it did not. */
  restore(): boolean;
  /** Empties what `restore` put back, if the writer has not changed it. Only
   * called after a `restore` that returned `true`. */
  clear(): void;
}

/** The typed direction, the retake target, and the draft to settle. A plain
 * Continue (Space, the Continue button, an empty composer) passes none of
 * them. A non-empty `instruction` never appends: it always opens a new take.
 * `retakeOf` names the part a retake replaces — the new take becomes its
 * sibling. */
export interface GenerationContinueRequest {
  readonly instruction?: string;
  readonly retakeOf?: string;
  readonly draft?: DraftHandle;
}

/** What a run remembers about the writer's draft: whether it was handed
 * back, and whether that took effect. The handle itself is stateless. */
interface DraftSlot {
  readonly handle: DraftHandle | null;
  restored: boolean;
  applied: boolean;
  cleared: boolean;
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
  options?: { readonly focus?: AdoptFocus | null; readonly announcement?: string }
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
  readonly draft: DraftSlot;
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

/** What a started run needs, once every check has passed. */
interface Admission {
  readonly connection: Connected;
  readonly storyId: string;
  readonly storyTitle: string;
  readonly focusedPartId: string | null;
  readonly plan: GenerationPlan;
}

function continueTargetOf(target: GenerationTarget): ContinueTarget {
  return target.mode === "append"
    ? { appendTo: target.appendTo, expectedTextHash: target.expectedTextHash }
    : { parentId: target.parentId };
}

/** The one place a draft handle is called. A handle is a UI callback; if it
 * throws, the run must still finish, so the failure stops here. A restore
 * happens at most once. A clear happens at most once, and only after a
 * restore that took effect: a landing with no restore has nothing to clear,
 * because the box was emptied when the send began. */
function settleDraft(slot: DraftSlot, action: "restore" | "clear"): void {
  if (slot.handle === null) return;
  try {
    if (action === "restore") {
      if (slot.restored) return;
      slot.restored = true;
      slot.applied = slot.handle.restore();
    } else {
      if (slot.cleared) return;
      slot.cleared = true;
      if (slot.applied) slot.handle.clear();
    }
  } catch {
    // A broken draft callback never breaks the run.
  }
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

  /** The one way a run ends, and what happens to the writer's draft with it:
   * `landed` clears it (the take is saved, or the stopped text was); `not-landed`
   * gives it back; `unsaved` keeps the text on screen as "Not saved" and also
   * gives the draft back, since the text is not safe yet. */
  function endRun(run: ActiveRun, disposition: "landed" | "not-landed" | "unsaved", message = ""): void {
    if (disposition === "unsaved") {
      run.phase = "unsaved";
      run.message = message;
      publish(run);
      settleDraft(run.draft, "restore");
      return;
    }
    setIdle();
    settleDraft(run.draft, disposition === "landed" ? "clear" : "restore");
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
        focus: { kind: "new-leaf-if", partId: run.focusAtStart },
        announcement: `Stopped. Part ${n} kept.`
      });
      endRun(run, "landed");
      if (failureMessage !== null) {
        pushToast(store, `${failureMessage} · generation stopped · text kept in ${run.storyTitle}.`);
      } else if (!applied) {
        pushToast(store, `Stopped writing in ${run.storyTitle}. Text kept.`);
      }
      return;
    }
    if (outcome.kind === "not-substantive") {
      deps.adoptPayload(run.storyId, outcome.payload, { announcement: "Stopped. Nothing was written." });
      endRun(run, "not-landed");
      if (failureMessage !== null) pushToast(store, failureMessage);
      return;
    }
    // "failed": the commit itself did not go through. Refresh what we can
    // from the best-effort reload, but keep the buffered text visible and
    // reachable (Copy/Discard) rather than lose it — decision 3, generalized
    // from "connection lost" to any commit failure, timeout-class or not.
    if (outcome.payload !== null) deps.adoptPayload(run.storyId, outcome.payload);
    endRun(run, "unsaved", errorMessage(outcome.error));
    pushToast(store, `Not saved: ${run.message}`);
  }

  async function settleStopped(run: ActiveRun, failureMessage: string | null): Promise<void> {
    run.phase = "settling";
    publish(run);
    const outcome = await saveStopped(run.api, saveRequestOf(run));
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
        focus: { kind: "new-leaf-if", partId: run.focusAtStart },
        announcement: `Part ${n} written.`
      });
      endRun(run, "landed");
      if (!applied) pushToast(store, `Part ${n} written in ${run.storyTitle}.`);
      return;
    }

    if (run.phase === "settling" && error === null) {
      // `stop()` already moved this run here, and the transport settled as a
      // clean stop. A rejection that arrives after Stop is still classified
      // below: output the server refused must never be saved just because
      // the reader pressed Stop first.
      await settleStopped(run, null);
      return;
    }

    const code = apiErrorCode(error);
    if (code === "resource_busy") {
      endRun(run, "not-landed");
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
      endRun(run, "not-landed");
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
      endRun(run, "unsaved", errorMessage(error));
      pushToast(store, `Not saved: ${run.message}`);
      return;
    }

    // A genuine provider/validation rejection (or a connection loss with
    // nothing substantive to keep): committing this prose would durably save
    // output the server refused, so it is discarded.
    endRun(run, "not-landed");
    // Always reload: a provider call that failed after it started still
    // records its attempt on the story, which moves the story's version. With
    // the old version held, the next Continue would be refused as a conflict
    // ("changed in another window") although nothing else changed. An
    // uncertain outcome needs the reload to reconcile anyway.
    await reloadBestEffort(run);
    pushToast(store, errorMessage(error));
  }


  /**
   * Every check before a run exists, in one place: it either returns what the
   * run needs, or refuses once — the writer's draft is handed back exactly
   * one time, with the toast, and nothing starts. The checks run before the
   * async preparation (settings, the append hash) and again after it, so a
   * connection that changed, a second start, or an editor opened in between is
   * still respected.
   */
  async function admit(request: GenerationContinueRequest, draft: DraftSlot): Promise<Admission | null> {
    const instruction = request.instruction ?? "";
    const refuse = (toast?: string, keptNote = true): null => {
      settleDraft(draft, "restore");
      if (toast !== undefined) pushToast(store, draft.handle !== null && keptNote ? `${toast} Draft kept.` : toast);
      return null;
    };
    /** `refused` is a toast to show; `silent` means there is nothing to say
     * (not connected, no open story) and the draft just comes back. */
    const check = (plan?: GenerationPlan): { readonly refused: string | null; readonly silent: boolean } => {
      const state = store.get();
      if (activeRun !== null) {
        const routeStory = state.route.kind === "story" ? state.route.id : "";
        return { refused: generationBusyToast(state, routeStory) ?? STORY_LOCKED_TOAST, silent: false };
      }
      if (state.connection.kind !== "connected" || state.route.kind !== "story") return { refused: null, silent: true };
      const story = state.story;
      if (story.kind !== "loaded" || story.payload.id !== state.route.id) return { refused: null, silent: true };
      // Before the preparation there is no plan yet, so the request is
      // checked as asked; afterwards the plan that was built is what is
      // checked, whatever focus has done in between.
      return {
        refused: plan !== undefined
          ? planEditorRefusal(state, story.payload.id, plan)
          : generationEditorRefusal(state, {
            focusedPartId: effectiveFocusedPartId(story),
            instruction,
            ...(request.retakeOf === undefined ? {} : { retakeOf: request.retakeOf })
          }),
        silent: false
      };
    };

    const first = check();
    if (first.silent) return refuse();
    if (first.refused !== null) return refuse(first.refused);

    const state = store.get();
    if (state.connection.kind !== "connected" || state.story.kind !== "loaded") return refuse();
    const connection = state.connection;
    const story = state.story;
    const focusedPartId = effectiveFocusedPartId(story);

    // A retake replaces a part that must still be on the line, and must not
    // be a summary (summaries are rewritten, not retaken).
    let retakeNode: StoryNode | null = null;
    if (request.retakeOf !== undefined) {
      retakeNode = story.payload.path.find((node) => node.id === request.retakeOf) ?? null;
      if (retakeNode === null || retakeNode.role === "summary") return refuse(RETAKE_GONE_TOAST, false);
    }

    // The saved instruction of a stopped new take must be the direction the
    // server actually used: the configured default, as the TUI passes
    // `activeWriting.defaultContinueDirection`. A settings read that fails
    // falls back to the built-in default.
    let defaultContinueDirection: string | undefined;
    try {
      defaultContinueDirection = (await connection.api.getSettings()).activeWriting.defaultContinueDirection;
    } catch {
      defaultContinueDirection = undefined;
    }
    let plan: GenerationPlan;
    try {
      plan = await planContinue(story.payload, {
        focusedPartId,
        instruction,
        ...(defaultContinueDirection === undefined ? {} : { defaultContinueDirection }),
        retakeNode
      });
    } catch (error) {
      return refuse(errorMessage(error));
    }

    const second = check(plan);
    if (second.refused !== null) return refuse(second.refused);
    // The story on screen must still be the one this plan was built for.
    const now = store.get().story;
    const sameStory = now.kind === "loaded" && now.payload.id === story.payload.id;
    if (second.silent || !sameStory || store.get().connection !== connection) return refuse();
    return { connection, storyId: story.payload.id, storyTitle: story.payload.title, focusedPartId, plan };
  }
  return {
    continue: async (request = {}) => {
      const draft: DraftSlot = { handle: request.draft ?? null, restored: false, applied: false, cleared: false };
      const admission = await admit(request, draft);
      if (admission === null) return;
      const { connection, storyId, storyTitle, focusedPartId, plan } = admission;
      const requestedInstruction = request.instruction ?? "";

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
        draft,
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
