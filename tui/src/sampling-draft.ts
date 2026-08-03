import type { SamplingSettingsV2 } from "../../shared/settings-v2-types.js";
import { applySamplingSettings } from "../../shared/sampling-capabilities.js";
import { validateSamplingSettings } from "../../shared/sampling-validation-policy.js";
import type { SettingsOverlayState } from "./state.js";

/** The write path for the whole Sampling draft: every scalar edit and every
 *  list-panel edit (stop, dry breakers, logit bias) lands here. Kept as its
 *  own leaf so `sampling-model.ts` and `sampling-list-model.ts` both import
 *  the draft write path the same way, instead of one of them reaching into a
 *  file named for the other's concern. */

export function validateSampling(sampling: SamplingSettingsV2): string | null {
  try {
    validateSamplingSettings(sampling);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function updateSamplingDraft(
  overlay: SettingsOverlayState,
  sampling: SamplingSettingsV2
): void {
  const document = overlay.draft.document === null || overlay.draft.selectedProfileId === null
    ? overlay.draft.document
    : applySamplingSettings(
        overlay.draft.document,
        sampling,
        overlay.draft.selectedProfileId
      );
  overlay.draft = { ...overlay.draft, document, sampling };
  if (overlay.conflict !== null) overlay.conflict.armed = false;
  overlay.result = null;
  if (overlay.sampling !== null) overlay.sampling.result = "draft updated · save in Settings";
}
