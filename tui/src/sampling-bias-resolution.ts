import {
  resolveSamplingKnob,
  samplingBiasEntryRejectionMessage,
  type SamplingBiasEntryResolution
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
 * every other row in the same batch is "idle" (not "unavailable") because
 * it is not implicated. */
export type SamplingBiasRowResolution =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "tokenizer-unavailable" }
  | { readonly kind: "rejected"; readonly entry: Extract<SamplingBiasEntryResolution, { kind: "rejected" }> }
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
  const result = state.result;
  if (result.kind === "tokenizer-unavailable") return { kind: "tokenizer-unavailable" };
  const entry = (list === "phraseBias" ? result.phraseBias : result.bannedStrings)
    .find((item) => item.phrase === phrase);
  if (entry === undefined) return { kind: "idle" };
  return entry.kind === "rejected"
    ? { kind: "rejected", entry }
    : { kind: "resolved", tokenIds: entry.tokenIds };
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
  nested.biasResolution = { kind: "pending" };
  context.backend.observe(resolveNow(overlay, nested, source, context, justCommitted));
}

async function resolveNow(
  overlay: SettingsOverlayState,
  nested: NonNullable<SettingsOverlayState["sampling"]>,
  source: AppSource,
  context: ActionContext,
  justCommitted: SamplingBiasJustCommitted | undefined
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
  const result = await source.api.resolveSamplingBias({
    settings,
    logitBias: sampling.logitBias,
    phraseBias: sampling.phraseBias,
    bannedStrings: sampling.bannedStrings
  });
  // Stale guard: land the result only if the sampling panel this request
  // started under is still the live one.
  if (overlay.sampling !== nested) return;
  if (justCommitted !== undefined && result.kind === "resolved") {
    const list = justCommitted.panel === "phraseBias" ? result.phraseBias : result.bannedStrings;
    const entry = list.find((item) => item.phrase === justCommitted.phrase);
    if (entry?.kind === "rejected") {
      unCommitRejectedEntry(overlay, justCommitted);
      nested.result = `${JSON.stringify(justCommitted.phrase)} kept out · `
        + samplingBiasEntryRejectionMessage(entry);
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

/** Reject at commit, not at save: an entry that cannot resolve to a single
 * token in every surface variant never stays in the draft, so the list
 * never fills with entries that silently do nothing. */
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
