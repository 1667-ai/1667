import type { ReasoningDisplayV2 } from "../../shared/settings-v2-types.js";
import {
  profileWithReasoning,
  reasoningDisplayUnavailableOrNull,
  reasoningRowChoices as draftReasoningRowChoices,
  reasoningRowHasArrows as draftReasoningRowHasArrows,
  reasoningRowHint,
  reasoningRowState as draftReasoningRowState,
  type ReasoningRowState
} from "../../shared/settings-profile-fields.js";
import { reasoningDisplayChoicesForRoute } from "../../shared/reasoning-display-capabilities.js";
import { cycleProfileField } from "./settings-profile-cycle.js";
import type { SettingsOverlayState } from "./state.js";

/** The story section's Reasoning cycler: what fold state a thought renders
 *  in. The state, hint, and choices live in `shared/` so the web reads the
 *  same rules; this module keeps the terminal's value text and cycling. */
export type { ReasoningRowState };
export { reasoningRowHint };

export function reasoningRowState(overlay: SettingsOverlayState): ReasoningRowState {
  return draftReasoningRowState(overlay.draft);
}

/** The unavailable state is informational. Do not wrap it in selector
 *  chevrons, because the row has no valid value to cycle to. */
export function reasoningRowValue(state: ReasoningRowState): string {
  if (state.route === null) return state.display;
  if (reasoningDisplayUnavailableOrNull(state)) return "—";
  return reasoningDisplayChoicesForRoute(state.route).length > 1
    ? `‹ ${state.display} ›`
    : state.display;
}

export function reasoningRowHasArrows(overlay: SettingsOverlayState): boolean {
  return draftReasoningRowHasArrows(overlay.draft);
}

export function reasoningRowChoices(overlay: SettingsOverlayState): readonly ReasoningDisplayV2[] {
  return draftReasoningRowChoices(overlay.draft);
}

/** C-09 cycler: `off` and `open` write the field; `marker` drops it. */
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
