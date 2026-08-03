import {
  resolveSamplingKnob,
  samplingBiasEntryRejectionMessage,
  samplingBiasResolutionFailureMessage,
  type SamplingBiasEntryResolution,
  type SamplingBiasResolutionResult
} from "../../shared/sampling-capabilities.js";
import { settingsProviderProbeTarget } from "./settings-provider-probe.js";
import { updateSamplingDraft } from "./sampling-panel-spec.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { samplingContextForOverlay } from "./sampling-model.js";
import type { SettingsOverlayState } from "./state.js";

/** One row's resolved-token display state, looked up by phrase text from
 * the whole-panel resolveSamplingBias result cached on the nested overlay
 * (tui/src/state.ts, SamplingBiasResolutionState). "rejected" names the one
 * entry that failed to resolve to a single token in every surface variant;
 * "shadowed" names the one with a real weight conflict on at least one of
 * its tokens — not necessarily every token, and not merely sharing one with
 * another entry that would write it the same weight (issue #282 review
 * round 3, finding 1); every other row in the same batch is "idle" (not
 * "unavailable") because it is not implicated. "failed" is a transport
 * failure, not a per-phrase outcome (finding 5) — every row shows it
 * identically, the same way every row shares "tokenizer-unavailable". */
export type SamplingBiasRowResolution =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "tokenizer-unavailable" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "rejected"; readonly entry: Extract<SamplingBiasEntryResolution, { kind: "rejected" }> }
  | { readonly kind: "shadowed"; readonly entry: Extract<SamplingBiasEntryResolution, { kind: "shadowed" }> }
  | { readonly kind: "resolved"; readonly tokenIds: readonly number[] };

/** Whether this route has any tokenizer strategy at all for phraseBias or
 * bannedStrings — the presentation layer already explains why through
 * samplingKnobPresentation's unavailable reason when it does not, so the
 * resolution cache just stays idle rather than firing a call with nothing
 * to resolve against. */
export function samplingBiasAvailableForOverlay(overlay: SettingsOverlayState): boolean {
  if (!overlay.view.editable) return false;
  const context = samplingContextForOverlay(overlay);
  return resolveSamplingKnob(context, "phraseBias").kind === "available"
    || resolveSamplingKnob(context, "bannedStrings").kind === "available";
}

export function samplingBiasRowResolution(
  overlay: SettingsOverlayState,
  list: "phraseBias" | "bannedStrings",
  phrase: string
): SamplingBiasRowResolution {
  const nested = overlay.sampling;
  if (nested === null) return { kind: "idle" };
  const state = nested.biasResolution;
  if (state.kind === "idle" || state.kind === "pending") return state;
  if (state.kind === "failed") return { kind: "failed", message: state.message };
  const result = state.result;
  if (result.kind === "tokenizer-unavailable") return { kind: "tokenizer-unavailable" };
  const entry = (list === "phraseBias" ? result.phraseBias : result.bannedStrings)
    .find((item) => item.phrase === phrase);
  if (entry === undefined) return { kind: "idle" };
  if (entry.kind === "rejected") return { kind: "rejected", entry };
  if (entry.kind === "shadowed") return { kind: "shadowed", entry };
  return { kind: "resolved", tokenIds: entry.tokenIds };
}

/** A phraseBias or bannedStrings entry a writer just committed, so the
 * refresh below can un-commit it if it turns out not to resolve — issue
 * #282 stage 1's commit-time UX: reject at commit rather than let the list
 * fill with an entry that biases nothing. */
export interface SamplingBiasJustCommitted {
  readonly panel: "phraseBias" | "bannedStrings";
  readonly phrase: string;
}

/**
 * Fetches resolveSamplingBias for the current draft's phraseBias and
 * bannedStrings together — one call, not one per phrase (issue #282 review,
 * finding E): a phrase-bias panel with 60 entries used to fire 60 worker
 * round trips just to open. Call this when the sampling editor opens and
 * again after each list-panel edit commits.
 *
 * Uses `backend.observe`, not `backend.run`: ActionRunner.run is single
 * -flight (tui/src/action-runtime.ts) and would reject a concurrent
 * resolution with a "busy" toast, or contend with whatever the writer does
 * next. `observe` surfaces only genuine failures, without claiming that slot.
 */
export function resolveSamplingBias(
  overlay: SettingsOverlayState,
  source: AppSource,
  context: ActionContext,
  justCommitted?: SamplingBiasJustCommitted
): void {
  const nested = overlay.sampling;
  if (nested === null) return;
  if (!samplingBiasAvailableForOverlay(overlay)) {
    nested.biasResolution = { kind: "idle" };
    return;
  }
  // Bumped before the call starts, captured for this call alone (issue #282
  // review round 2, finding 5): `pending` lands synchronously here but every
  // outcome lands asynchronously in resolveNow, so two overlapping commits —
  // a writer typing a second entry before the first one's check returns —
  // otherwise settle in whichever order their network calls happen to
  // finish, with only panel identity (`overlay.sampling !== nested`) as a
  // guard. A generation mismatch means a newer call has since started, so an
  // older one's outcome is stale and must not overwrite it.
  nested.resolutionGeneration += 1;
  const generation = nested.resolutionGeneration;
  nested.biasResolution = { kind: "pending" };
  context.backend.observe(resolveNow(overlay, nested, source, context, justCommitted, generation));
}

async function resolveNow(
  overlay: SettingsOverlayState,
  nested: NonNullable<SettingsOverlayState["sampling"]>,
  source: AppSource,
  context: ActionContext,
  justCommitted: SamplingBiasJustCommitted | undefined,
  generation: number
): Promise<void> {
  const sampling = overlay.draft.sampling;
  const probed = overlay.view.editable ? overlay.draft.generation : overlay.view.effective;
  const settings = settingsProviderProbeTarget(
    overlay.view,
    probed,
    overlay.connectionSecrets,
    overlay.draft.document,
    overlay.draft.selectedProfileId
  );
  let result: SamplingBiasResolutionResult;
  try {
    result = await source.api.resolveSamplingBias({
      settings,
      logitBias: sampling.logitBias,
      phraseBias: sampling.phraseBias,
      bannedStrings: sampling.bannedStrings
    });
  } catch (error) {
    // Issue #282 review round 2, finding 5: the worker call throwing — the
    // provider-check timeout elapsing against a slow llama.cpp server is the
    // everyday case — used to leave `pending` set forever, with only a toast
    // (from ActionRunner.observe) to say anything went wrong. `failed`
    // clears that dead end, and the entry just committed is kept out rather
    // than left in the draft unchecked: a transport failure means 1667
    // cannot vouch for it, which is exactly the "unverified" state commit-
    // time rejection already exists to prevent.
    if (overlay.sampling !== nested || nested.resolutionGeneration !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    if (justCommitted !== undefined) {
      unCommitRejectedEntry(overlay, justCommitted);
      nested.result = `${JSON.stringify(justCommitted.phrase)} kept out · could not check it: ${message}`;
    }
    nested.biasResolution = { kind: "failed", message };
    context.repaint();
    return;
  }
  // Stale guard: land the result only if the sampling panel this request
  // started under is still the live one, and no newer resolution has since
  // started (finding 5's generation counter).
  if (overlay.sampling !== nested || nested.resolutionGeneration !== generation) return;
  if (justCommitted !== undefined) {
    const keptOutReason = justCommittedKeptOutReason(result, justCommitted);
    if (keptOutReason !== null) {
      unCommitRejectedEntry(overlay, justCommitted);
      nested.result = `${JSON.stringify(justCommitted.phrase)} kept out · ${keptOutReason}`;
      // Paint the dropped row and the result line now (issue #282 review
      // round 3, finding 5) — the recursive resolveSamplingBias call below
      // starts a fresh round trip (a full re-probe of every remaining
      // variant text on a llama-cpp route) before it lands, and without this
      // the screen would keep showing the old frame, row and all, until
      // that second call returns.
      context.repaint();
      // The draft just changed again (the entry was removed) — resolve once
      // more so the cache reflects the list the writer actually has, rather
      // than showing a rejection for a phrase that is no longer there.
      resolveSamplingBias(overlay, source, context);
      return;
    }
  }
  nested.biasResolution = { kind: "ready", result };
  context.repaint();
}

/** Why the entry a writer just committed does not stay committed, or null
 * when it is fine to keep. A whole-panel "tokenizer-unavailable" result
 * (issue #282 review round 2, finding 5 — this used to only un-commit on a
 * "resolved" result, so this case, like a transport failure, left the entry
 * in the draft unchecked) and a per-entry "rejected" or "shadowed" outcome
 * (finding 1) are all reasons 1667 cannot honestly keep the entry — the
 * three differ only in which message they carry. */
function justCommittedKeptOutReason(
  result: SamplingBiasResolutionResult,
  justCommitted: SamplingBiasJustCommitted
): string | null {
  if (result.kind === "tokenizer-unavailable") {
    return `could not check it: ${samplingBiasResolutionFailureMessage(result)}`;
  }
  const list = justCommitted.panel === "phraseBias" ? result.phraseBias : result.bannedStrings;
  const entry = list.find((item) => item.phrase === justCommitted.phrase);
  return entry !== undefined && entry.kind !== "resolved"
    ? samplingBiasEntryRejectionMessage(entry)
    : null;
}

/** Reject at commit, not at save: an entry that cannot resolve to a single
 * token in every surface variant — or that shadows, or is shadowed by,
 * another entry's tokens (finding 1) — never stays in the draft, so the
 * list never fills with entries that silently do nothing. */
function unCommitRejectedEntry(
  overlay: SettingsOverlayState,
  justCommitted: SamplingBiasJustCommitted
): void {
  const sampling = overlay.draft.sampling;
  if (justCommitted.panel === "phraseBias") {
    updateSamplingDraft(overlay, {
      ...sampling,
      phraseBias: sampling.phraseBias.filter((entry) => entry.phrase !== justCommitted.phrase)
    });
  } else {
    updateSamplingDraft(overlay, {
      ...sampling,
      bannedStrings: sampling.bannedStrings.filter((phrase) => phrase !== justCommitted.phrase)
    });
  }
}
