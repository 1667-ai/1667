import type { ChatMessage } from "../../shared/prompt-plan.js";
import {
  promptCountFingerprint,
  promptCountShape,
  type PromptTokenCount
} from "../../shared/tokenize-source.js";
import { projectNextRequest } from "./request-context.js";
import { nextRequestEstimate } from "./request-projection.js";
import type { RuntimeState } from "./state.js";

type TimerHandle = ReturnType<typeof setTimeout>;

/** Roughly a quarter second of quiet before a count. Long enough that a burst
 *  of keystrokes collapses into one call; short enough that the meter still
 *  reads as live once typing stops. */
const DEBOUNCE_MS = 250;

/** After a genuine failure (not an abort), how long the lane refuses to ask
 *  again. `notify()` rides every repaint, and a disconnected TUI still
 *  repaints — the connection banner animates — so without a cooldown a down
 *  backend would be re-probed at the debounce rate for as long as it stayed
 *  down. A few seconds is long enough that a stuck backend is not hammered,
 *  short enough that a reconnect (recovery-orchestration.ts reloads the
 *  payload, which repaints) is felt within a handful of counts, not minutes. */
const FAILURE_COOLDOWN_MS = 5_000;

/** The one method this lane needs from `StoryApi`, named narrowly so a test
 *  can fake it without building the rest of the client. */
export interface PromptTokenCountApi {
  countPromptTokens(
    messages: readonly ChatMessage[],
    signal?: AbortSignal
  ): Promise<PromptTokenCount>;
}

export interface PromptTokenCountDependencies {
  readonly state: RuntimeState;
  readonly api: PromptTokenCountApi;
  readonly repaint: () => void;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (timer: TimerHandle) => void;
}

export interface PromptTokenCountLane {
  /** Call once after every dispatched action. Cheap: it reads a few state
   *  fields and resets a timer, and never touches the projection itself until
   *  that timer fires — the render path's `repaint` funnel is already the
   *  one place every state-changing action passes through, so this rides it
   *  rather than teaching the dispatcher a second notification path. */
  notify(): void;
  dispose(): void;
}

/**
 * Keeps `state.promptTokenCount` answering the prompt currently projected,
 * without ever touching `ActionRuntime` (see action-runtime.ts): that lane is
 * exclusive, so a count queued behind it would arrive late and would refuse
 * the user's next action with a `busy` toast for a number nobody asked for.
 * This lane calls the backend directly and runs beside it.
 *
 * Modeled on background-update-check.ts: injected `schedule`/`cancel` for
 * deterministic tests, one `AbortController` for the in-flight call, and a
 * dispose that leaves nothing pending.
 *
 * A failure of any kind — a rejection, an abort, a disconnected backend — is
 * not an error this lane surfaces. It clears to the estimate silently: no
 * toast, no notice, nothing logged (issue 288). A genuine failure (not an
 * abort) also arms a short cooldown and forgets the ask, so a backend that
 * comes back is asked again rather than staying pinned to the estimate for
 * the rest of the session — server/tokenize-probe.ts makes the same choice
 * server-side and refuses to cache a `probe-failed` result for exactly this
 * reason.
 */
export function startPromptTokenCountLane(
  dependencies: PromptTokenCountDependencies
): PromptTokenCountLane {
  const { state, api, repaint } = dependencies;
  const schedule = dependencies.schedule ?? setTimeout;
  const cancel = dependencies.cancel ?? clearTimeout;

  let timer: TimerHandle | null = null;
  let cooldownTimer: TimerHandle | null = null;
  let controller: AbortController | null = null;
  let disposed = false;
  let coolingDown = false;
  let lastMode = state.mode;
  let lastStoryId = state.payload.id;
  // The fingerprint last asked about (successfully dispatched or already
  // answered), so a debounce firing on an unrelated repaint — a scroll, a
  // cursor move — never re-asks the backend about a prompt that has not
  // actually changed. A genuine failure clears this (see runCount), so the
  // same unchanged prompt is retried once the cooldown lets it.
  let lastAskedFingerprint: string | null = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const clearCooldownTimer = () => {
    if (cooldownTimer !== null) cancel(cooldownTimer);
    cooldownTimer = null;
  };
  const abortInFlight = () => {
    controller?.abort();
    controller = null;
  };
  const armCooldown = () => {
    if (disposed) return;
    coolingDown = true;
    clearCooldownTimer();
    cooldownTimer = schedule(() => {
      cooldownTimer = null;
      coolingDown = false;
    }, FAILURE_COOLDOWN_MS);
  };

  const runCount = () => {
    if (disposed || coolingDown) return;
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const fingerprint = promptCountFingerprint(estimate.messages);
    if (fingerprint === lastAskedFingerprint) return;
    lastAskedFingerprint = fingerprint;
    const shape = promptCountShape(estimate.messages);
    abortInFlight();
    const active = new AbortController();
    controller = active;
    void (async () => {
      let count: PromptTokenCount;
      try {
        count = await api.countPromptTokens(estimate.messages, active.signal);
      } catch {
        // An abort — from dispose(), or from a newer count superseding this
        // one — is not a server failure and arms no cooldown; the fingerprint
        // it asked about has already moved on with it. A genuine rejection
        // (a thrown error, a disconnected backend) forgets the ask so the
        // next pass retries, but only after the cooldown above.
        if (!active.signal.aborted) {
          if (lastAskedFingerprint === fingerprint) lastAskedFingerprint = null;
          armCooldown();
        }
        return;
      } finally {
        if (controller === active) controller = null;
      }
      if (disposed || active.signal.aborted) return;
      // A late answer must never describe newer text: recompute the live
      // projection and discard anything that no longer matches what was asked.
      const current = projectNextRequest(state);
      const currentEstimate = nextRequestEstimate(current.payload, current.context);
      if (promptCountFingerprint(currentEstimate.messages) !== fingerprint) return;
      state.promptTokenCount = { shape, count };
      repaint();
    })();
  };

  const queueDebounced = () => {
    clearTimer();
    timer = schedule(() => {
      timer = null;
      runCount();
    }, DEBOUNCE_MS);
  };

  const notify = () => {
    if (disposed) return;
    if (state.payload.id !== lastStoryId) {
      lastStoryId = state.payload.id;
      state.promptTokenCount = null;
      lastAskedFingerprint = null;
      abortInFlight();
      clearTimer();
    }
    const openedRequestViewer = state.mode === "REQUEST" && lastMode !== "REQUEST";
    lastMode = state.mode;
    if (openedRequestViewer) {
      // On demand and affordable: no debounce.
      clearTimer();
      runCount();
      return;
    }
    queueDebounced();
  };

  return {
    notify,
    dispose() {
      disposed = true;
      clearTimer();
      clearCooldownTimer();
      abortInFlight();
    }
  };
}
