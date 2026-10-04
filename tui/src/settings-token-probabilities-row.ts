import {
  profileWithTokenProbabilities,
  tokenProbabilitiesChoices,
  tokenProbabilitiesRowHasArrows as draftHasArrows,
  tokenProbabilitiesRowHint,
  tokenProbabilitiesRowState as draftRowState,
  type TokenProbabilitiesRowState
} from "../../shared/settings-profile-fields.js";
import { cycleProfileField } from "./settings-profile-cycle.js";
import type { SettingsOverlayState } from "./state.js";

/** The generation section's alternative-count row: how many alternative
 *  tokens each request asks the provider to report. The capability rules,
 *  hint, and choices live in `shared/settings-profile-fields.ts`; this module
 *  keeps the terminal's value text and cycling. */
export type { TokenProbabilitiesRowState };
export { tokenProbabilitiesRowHint };

export function tokenProbabilitiesRowState(overlay: SettingsOverlayState): TokenProbabilitiesRowState {
  return draftRowState(overlay.view, overlay.draft);
}

/** An unavailable empty state is informational. A stored count keeps its
 * selector only so the writer can turn the incompatible value off. */
export function tokenProbabilitiesRowValue(state: TokenProbabilitiesRowState): string {
  if (state.resolution === null) return "—";
  if (state.resolution.kind === "unavailable") {
    return state.count === null ? "—" : `‹ ${state.count} ›`;
  }
  return `‹ ${state.count === null ? "off" : state.count} ›`;
}

export function tokenProbabilitiesRowHasArrows(overlay: SettingsOverlayState): boolean {
  return draftHasArrows(overlay.view, overlay.draft);
}

/** C-09 cycler: `off` writes a profile with the key dropped, and every other
 *  position writes it present with a count in `1..MAX_ALTERNATIVE_TOKENS`. */
export function cycleTokenProbabilitiesControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): string | null {
  if (!tokenProbabilitiesRowHasArrows(overlay)) return null;
  const next = cycleProfileField(
    overlay,
    step,
    tokenProbabilitiesChoices(overlay.view, overlay.draft),
    (profile) => profile.tokenProbabilities ?? null,
    profileWithTokenProbabilities as never
  );
  return next === undefined ? null : next === null ? "off" : String(next);
}
