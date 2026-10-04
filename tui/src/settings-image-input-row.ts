import { imageInputStatus } from "../../shared/settings-profile-fields.js";
import type { SettingsOverlayState } from "./state.js";

/** The basic model editor's read-only image-input status row. It never
 *  cycles: it shows what the route and the exact model knowledge already say
 *  (`shared/settings-profile-fields.ts`). */
export interface ImageInputRowState {
  readonly supported: boolean;
  readonly hint: string;
}

export function imageInputRowState(overlay: SettingsOverlayState): ImageInputRowState {
  return imageInputStatus(overlay.draft);
}

export function imageInputRowValue(state: ImageInputRowState): string {
  return state.supported ? "available" : "—";
}

export function imageInputRowHint(state: ImageInputRowState): string {
  return state.hint;
}
