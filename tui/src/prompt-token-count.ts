import type { ChatMessage } from "../../shared/prompt-plan.js";
import {
  countedPromptChars,
  MAX_COUNTED_PROMPT_CHARS,
  promptCountFingerprint,
  type PromptTokenCount
} from "../../shared/tokenize-source.js";
import { projectNextRequest, promptProjectionIdentity } from "./request-context.js";
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

/** How long a count from a model server is worth keeping without asking again.
 *
 * The backend ages its own cached remote counts for the same reason: a local
 * llama.cpp or KoboldCpp can load a different model at the same address, and
 * nothing 1667 keys on has to change with it. Without a matching bound here
 * the client would simply never ask again for an unchanged prompt, and the
 * backend's bound would never be reached. A count from the bundled tokenizer
 * needs no bound — it is a pure function of the model and the text. */
const REMOTE_COUNT_MAX_AGE_MS = 30_000;

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
  let lastMode = state.mode;
  let lastStoryId = state.payload.id;
  let lastRoute = state.generationRoute;
  /** The route that already answered `no-source`; nothing to ask it again. */
  let settledRoute: string | null = null;
  // The fingerprint last asked about (successfully dispatched or already
  // answered), so a debounce firing on an unrelated repaint — a scroll, a
  // cursor move — never re-asks the backend about a prompt that has not
  // actually changed. A genuine failure clears this (see runCount), so the
  // same unchanged prompt is retried once the cooldown lets it.
  let lastAskedFingerprint: string | null = null;
  /** Retires a model server's count when it reaches its age bound. Only a
   *  timer makes that bound real: an idle session repaints rarely, and a bound
   *  nothing observes is a promise the meter does not keep. */
  let expiryTimer: TimerHandle | null = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const clearCooldownTimer = () => {
    if (cooldownTimer !== null) cancel(cooldownTimer);
    cooldownTimer = null;
  };
  const clearExpiryTimer = () => {
    if (expiryTimer !== null) cancel(expiryTimer);
    expiryTimer = null;
  };
  /** At the bound, the count stops being shown and the same prompt becomes
   * askable again. Retiring it first is what keeps a mark off a number 1667 is
   * no longer willing to vouch for, whether or not the refresh then succeeds. */
  const armExpiry = () => {
    clearExpiryTimer();
    expiryTimer = schedule(() => {
      expiryTimer = null;
      if (disposed) return;
      state.promptTokenCount = null;
      lastAskedFingerprint = null;
      repaint();
      queueDebounced();
    }, REMOTE_COUNT_MAX_AGE_MS);
  };
  const abortInFlight = () => {
    controller?.abort();
    controller = null;
  };
  /** The live timer is the cooldown; there is no separate flag to fall out of
   * step with it. */
  const armCooldown = () => {
    if (disposed) return;
    clearCooldownTimer();
    cooldownTimer = schedule(() => {
      cooldownTimer = null;
      // The cooldown ending is itself the reason to try again. Waiting for
      // some later repaint would leave the meter estimated for as long as the
      // writer happened to sit still.
      queueDebounced();
    }, FAILURE_COOLDOWN_MS);
  };

  const runCount = (onDemand = false) => {
    if (disposed) return;
    const projected = projectNextRequest(state);
    const estimate = nextRequestEstimate(projected.payload, projected.context);
    const route = state.generationRoute;
    const fingerprint = promptCountFingerprint(estimate.messages, route);
    // An unchanged prompt is not asked about twice — unless the answer was a
    // model server's and has aged past what it is worth. Opening the request
    // viewer also asks again: it is on demand, and it is the one surface a
    // writer opens to check the number.
    const moved = fingerprint !== lastAskedFingerprint;
    if (!moved && !onDemand) return;
    // Retire the answer to the previous prompt before anything can refuse the
    // replacement: the cooldown below must not be able to hold a stale mark on
    // screen for its whole five seconds. Only a prompt that actually moved
    // retires anything — re-asking the same one for freshness must not blink
    // its number back to an estimate on the way.
    if (moved && state.promptTokenCount !== null) {
      state.promptTokenCount = null;
      repaint();
    }
    if (cooldownTimer !== null) return;
    // This route has already answered that it has no tokenizer. That does not
    // change while the route stands, so asking again would ship the whole
    // prompt for a number already known.
    if (settledRoute === route) return;
    // The ceiling belongs on this side of the wire. The backend refuses an
    // oversized array too, but only after it has been serialized, sent,
    // parsed, and validated — for an answer 1667 can reach without asking.
    if (countedPromptChars(estimate.messages) > MAX_COUNTED_PROMPT_CHARS) {
      lastAskedFingerprint = fingerprint;
      state.promptTokenCount = {
        identity: promptProjectionIdentity(state, projected.context),
        route,
        count: { kind: "estimate", reason: "too-large" }
      };
      repaint();
      return;
    }
    lastAskedFingerprint = fingerprint;
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
          forgetAsk(fingerprint);
          armCooldown();
        }
        return;
      } finally {
        if (controller === active) controller = null;
      }
      if (disposed || active.signal.aborted) return;
      // A late answer must never describe newer text, and must never describe
      // another connection: recompute the live projection under the live route
      // and discard anything that no longer matches what was asked.
      const current = projectNextRequest(state);
      const currentEstimate = nextRequestEstimate(current.payload, current.context);
      if (promptCountFingerprint(currentEstimate.messages, state.generationRoute)
        !== fingerprint) return;
      if (count.kind === "estimate" && count.reason === "probe-failed") {
        // A probe that failed resolves rather than rejects, so it arrives
        // looking like an answer. It is not one: the backend refuses to cache
        // it because "a server that came back must be reachable on the next
        // pass", and pinning it here would undo that. Show the estimate, then
        // let the cooldown release another attempt.
        forgetAsk(fingerprint);
        armCooldown();
      } else if (count.kind === "estimate" && count.reason === "no-source") {
        // Settled for as long as the route stands: this preset has no
        // tokenizer, and no retry invents one. Half the presets answer this,
        // and without it each would ship the whole prompt again after every
        // pause in typing, for a number that cannot change.
        //
        // `too-large` is deliberately not settled here. It describes the
        // prompt, not the route, and a prompt that shrinks becomes countable
        // again.
        settledRoute = route;
      }
      // Taken now, not before the call: the fingerprint check above already
      // proved the messages are the ones counted, and reading the identity
      // here describes the live state exactly, so an unrelated move of the
      // cursor while the answer was in flight cannot retire a good count.
      // A model server's answer is only worth keeping for a while; a bundled
      // one is worth keeping until the prompt or the route moves.
      if (count.kind === "counted" && count.source !== "bundled-openai") armExpiry();
      else clearExpiryTimer();
      state.promptTokenCount = {
        identity: promptProjectionIdentity(state, current.context),
        route,
        count
      };
      repaint();
    })();
  };

  /** Let the same prompt be asked about again after a failure. */
  const forgetAsk = (fingerprint: string) => {
    if (lastAskedFingerprint === fingerprint) lastAskedFingerprint = null;
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
    // A new story or a new route retires the stored answer at once. Waiting
    // for the debounce would leave a count from the old story, or from the old
    // connection, marked as though it described this one.
    if (state.payload.id !== lastStoryId || state.generationRoute !== lastRoute) {
      lastStoryId = state.payload.id;
      lastRoute = state.generationRoute;
      settledRoute = null;
      state.promptTokenCount = null;
      lastAskedFingerprint = null;
      clearExpiryTimer();
      abortInFlight();
      clearTimer();
      // A failure against the story or the route just left says nothing about
      // the one just arrived. It gets its own attempt, not the tail of
      // somebody else's backoff.
      clearCooldownTimer();
    }
    const openedRequestViewer = state.mode === "REQUEST" && lastMode !== "REQUEST";
    lastMode = state.mode;
    if (openedRequestViewer) {
      // On demand and affordable: no debounce.
      clearTimer();
      runCount(true);
      return;
    }
    queueDebounced();
  };

  return {
    notify,
    dispose() {
      disposed = true;
      clearExpiryTimer();
      clearTimer();
      clearCooldownTimer();
      abortInFlight();
    }
  };
}
