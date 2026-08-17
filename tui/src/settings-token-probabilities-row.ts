import type { GenerationProfileV2 } from "../../shared/settings-v2-types.js";
import { MAX_ALTERNATIVE_TOKENS } from "../../shared/token-probabilities.js";
import {
  resolveTokenProbabilities,
  type TokenProbabilityResolution
} from "../../shared/token-probability-capabilities.js";
import { samplingContextForOverlayOrNull } from "./sampling-model.js";
import { cycleProfileField } from "./settings-profile-cycle.js";
import type { SettingsOverlayState } from "./state.js";

/** The generation section's alternative-count row: how many alternative
 *  tokens each request asks the provider to report. The whole control lives
 *  here rather than beside the other profile rows, because its value, its
 *  hint, its choices, and its write path all turn on the same capability
 *  resolution, and that is more than one row's worth of reasoning. */

/** `off`, then every alternative count a request can ask for.
 *  `MAX_ALTERNATIVE_TOKENS` is the provider ceiling
 *  `shared/token-probabilities.ts` enforces, so this row can never cycle
 *  past it — `off` is the field's absence, never the number 0. */
const TOKEN_PROBABILITIES_CHOICES: readonly (number | null)[] = [
  null,
  ...Array.from({ length: MAX_ALTERNATIVE_TOKENS }, (_, index) => index + 1)
];

/** Value and hint both need the resolved capability and the stored count, so
 *  the row resolves once and feeds both, the way the cache row feeds itself
 *  from one `promptCacheSummaryParts`.
 *
 *  `resolution` is null exactly when there is nothing to resolve against —
 *  an editable draft with no document or no selected profile. That is a
 *  broken draft, not a route, so it is not folded into
 *  `TokenProbabilityUnavailableReason`, which describes routes only. The row
 *  renders unavailable with no reason rather than claim one that is untrue. */
export interface TokenProbabilitiesRowState {
  readonly resolution: TokenProbabilityResolution | null;
  readonly count: number | null;
}

export function tokenProbabilitiesRowState(
  overlay: SettingsOverlayState
): TokenProbabilitiesRowState {
  const context = samplingContextForOverlayOrNull(overlay);
  return {
    resolution: context === null ? null : resolveTokenProbabilities(context),
    count: currentTokenProbabilities(overlay)
  };
}

/** F-2's unavailable look, matched from the sampling panel's own scalar rows:
 *  the value chip collapses to `‹ — ›` rather than showing a count the
 *  request will not carry. */
export function tokenProbabilitiesRowValue(state: TokenProbabilitiesRowState): string {
  if (state.resolution === null || state.resolution.kind === "unavailable") return "‹ — ›";
  return `‹ ${state.count === null ? "off" : state.count} ›`;
}

export function tokenProbabilitiesRowHint(state: TokenProbabilitiesRowState): string {
  if (state.resolution === null) return "";
  if (state.resolution.kind === "available") {
    return "Shows other tokens the model considered while writing.";
  }
  if (state.resolution.reason === "legacy-v1") return "Legacy settings are read-only.";
  if (state.resolution.reason === "preset-unknown") {
    return "Alternative token data might not be available from this provider.";
  }
  return state.resolution.reason === "model-refused"
    ? "This model does not offer alternative token data."
    : "This provider does not offer alternative token data.";
}

/** C-09 cycler: `off` writes a profile with the key dropped, and every other
 *  position writes it present with a count in `1..MAX_ALTERNATIVE_TOKENS` —
 *  the field is never set to `0`, and never set to `undefined`. */
export function cycleTokenProbabilitiesControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  const next = cycleProfileField(
    overlay,
    step,
    tokenProbabilitiesChoices(overlay),
    (profile) => profile.tokenProbabilities ?? null,
    profileWithTokenProbabilities
  );
  return next === undefined ? null : next === null ? "off" : String(next);
}

function currentTokenProbabilities(overlay: SettingsOverlayState): number | null {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  if (document === null || profileId === null) return null;
  return document.profiles[profileId]?.tokenProbabilities ?? null;
}

/** Every route offers `off`; only a route the capability matrix reports
 *  available also offers a count, so cycling on an unavailable route — or on
 *  a broken draft with no route to resolve — stays a no-op instead of
 *  writing a value the request was never going to carry. */
function tokenProbabilitiesChoices(overlay: SettingsOverlayState): readonly (number | null)[] {
  return tokenProbabilitiesRowState(overlay).resolution?.kind === "available"
    ? TOKEN_PROBABILITIES_CHOICES
    : [null];
}

function profileWithTokenProbabilities(
  profile: GenerationProfileV2,
  tokenProbabilities: number | null
): GenerationProfileV2 {
  if (tokenProbabilities === null) {
    const { tokenProbabilities: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, tokenProbabilities };
}
