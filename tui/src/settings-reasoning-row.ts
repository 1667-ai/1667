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
      : resolveSettingsProfile(document, profileId) as never,
    display: profile?.reasoning ?? "marker"
  };
}

/** The unavailable state is informational. Do not wrap it in selector
 *  chevrons, because the row has no valid value to cycle to. */
export function reasoningRowValue(state: ReasoningRowState): string {
  if (state.route === null) return state.display;
  if (reasoningDisplayAvailabilityForRoute(state.route, state.display).kind === "unavailable") return "—";
  return reasoningDisplayChoicesForRoute(state.route).length > 1
    ? `‹ ${state.display} ›`
    : state.display;
}

/** Whether the selected route can cycle the current reasoning display. A
 *  missing route or an unsupported display is a read-only status, not a
 *  one-choice selector. */
export function reasoningRowHasArrows(overlay: SettingsOverlayState): boolean {
  const state = reasoningRowState(overlay);
  return state.route !== null
    && reasoningDisplayChoicesForRoute(state.route).length > 1
    && reasoningDisplayAvailabilityForRoute(state.route, state.display).kind === "available";
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
  if (!reasoningRowHasArrows(overlay)) return null;
  return cycleProfileField(
    overlay,
    step,
    reasoningRowChoices(overlay),
    (profile) => profile.reasoning ?? "marker",
    profileWithReasoning as never
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
