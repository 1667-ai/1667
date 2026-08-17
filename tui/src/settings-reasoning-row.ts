import {
  REASONING_DISPLAY_V2_VALUES,
  type GenerationProfileV2,
  type ReasoningDisplayV2
} from "../../shared/settings-v2-types.js";
import { resolveSettingsProfile, type SelectedSettingsRouteV2 } from "../../shared/settings-route.js";
import {
  reasoningDisplayAvailabilityForRoute,
  reasoningDisplayChoicesForRoute
} from "../../shared/reasoning-display-capabilities.js";
import { cycleProfileField } from "./settings-profile-cycle.js";
import type { SettingsOverlayState } from "./state.js";

/** The story section's Reasoning cycler: what fold state a thought renders
 *  in. The whole control lives here rather than beside the other profile
 *  rows, the same reason `token-probabilities` does — its value, its hint,
 *  and its choices all turn on one route-level capability resolution.
 *
 *  `route` is null exactly when there is nothing to resolve against — an
 *  editable draft with no document or no selected profile. That is a broken
 *  draft, not a route, so the row renders unavailable with no reason rather
 *  than claim one that is untrue — the same rule `TokenProbabilitiesRowState`
 *  documents for its own null `resolution`. */
export interface ReasoningRowState {
  readonly route: SelectedSettingsRouteV2 | null;
  readonly display: ReasoningDisplayV2;
}

export function reasoningRowState(overlay: SettingsOverlayState): ReasoningRowState {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  const profile = document === null || profileId === null ? undefined : document.profiles[profileId];
  return {
    route: document === null || profileId === null || profile === undefined
      ? null
      : resolveSettingsProfile(document, profileId),
    display: profile?.reasoning ?? "marker"
  };
}

/** F-2's unavailable look, matched from `token-probabilities`: the value
 *  chip collapses to `‹ — ›` rather than showing a fold state the route can
 *  never populate. */
export function reasoningRowValue(state: ReasoningRowState): string {
  if (state.route !== null && reasoningDisplayAvailabilityForRoute(state.route, state.display).kind === "unavailable") {
    return "‹ — ›";
  }
  return `‹ ${state.display} ›`;
}

export function reasoningRowHint(state: ReasoningRowState): string {
  if (state.route === null) return "Controls whether model reasoning is hidden, marked, or shown.";
  const availability = reasoningDisplayAvailabilityForRoute(state.route, state.display);
  return availability.kind === "unavailable"
    ? "This route does not expose model reasoning."
    : "Controls whether model reasoning is hidden, marked, or shown.";
}

/** Every route offers `off`; only a route the capability matrix reports
 *  available also offers `marker`/`open`, so cycling on an unavailable route
 *  — or on a broken draft with no route to resolve — stays a no-op instead
 *  of writing a fold state the route was never going to populate. */
export function reasoningRowChoices(overlay: SettingsOverlayState): readonly ReasoningDisplayV2[] {
  const state = reasoningRowState(overlay);
  return state.route === null ? REASONING_DISPLAY_V2_VALUES : reasoningDisplayChoicesForRoute(state.route);
}

/** C-09 cycler: `off` writes a profile with the key dropped, same as
 *  `marker` (both mean "absent" — `marker` is the default), and `open` is
 *  the one position that writes the field. */
export function cycleReasoningControl(
  overlay: SettingsOverlayState,
  step: -1 | 1
): ReasoningDisplayV2 | null {
  return cycleProfileField(
    overlay,
    step,
    reasoningRowChoices(overlay),
    (profile) => profile.reasoning ?? "marker",
    profileWithReasoning
  ) ?? null;
}

function profileWithReasoning(
  profile: GenerationProfileV2,
  reasoning: ReasoningDisplayV2
): GenerationProfileV2 {
  if (reasoning === "marker") {
    const { reasoning: _dropped, ...rest } = profile;
    return rest;
  }
  return { ...profile, reasoning };
}
