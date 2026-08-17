import { resolveSettingsProfile, type SelectedSettingsRouteV2 } from "../../shared/settings-route.js";
import { resolveImageInputCapability } from "../../shared/image-input-capabilities.js";
import type { SettingsOverlayState } from "./state.js";

/** The basic model editor's read-only image-input status row, following
 *  tui/src/settings-reasoning-row.ts's structure. Unlike the Reasoning row,
 *  this one never cycles: schema 3 (where a per-model override could be
 *  stored) is not what release N writes, so there is nothing here to edit
 *  yet. The Advanced editor owns the explicit override once schema 3 is
 *  live. This row only shows what exact built-in model knowledge and the
 *  route's protocol already resolve
 *  (shared/image-input-capabilities.ts). */
export interface ImageInputRowState {
  readonly route: SelectedSettingsRouteV2 | null;
}

export function imageInputRowState(overlay: SettingsOverlayState): ImageInputRowState {
  const document = overlay.draft.document;
  const profileId = overlay.draft.selectedProfileId;
  const profile = document === null || profileId === null ? undefined : document.profiles[profileId];
  return {
    route: document === null || profileId === null || profile === undefined
      ? null
      : resolveSettingsProfile(document, profileId)
  };
}

/** F-2's unavailable look, matched from `reasoning`/`token-probabilities`:
 *  the chip collapses to `‹ - ›` whenever the resolved capability is not
 *  `"supported"`. This is the strict gate: only `"supported"` ever
 *  authorizes an image. */
export function imageInputRowValue(state: ImageInputRowState): string {
  if (state.route === null) return "‹ - ›";
  const resolution = resolveImageInputCapability({
    protocol: state.route.connection.protocol,
    remoteModelId: state.route.model.remoteId
  });
  return resolution.support === "supported" ? "‹ available ›" : "‹ - ›";
}

export function imageInputRowHint(state: ImageInputRowState): string {
  if (state.route === null) return "Shows whether this model accepts image attachments.";
  const resolution = resolveImageInputCapability({
    protocol: state.route.connection.protocol,
    remoteModelId: state.route.model.remoteId
  });
  if (resolution.support === "supported") return "This model accepts image attachments.";
  if (resolution.reason === "protocol-unsupported") return "The selected protocol cannot send image attachments.";
  return "Image support is unknown for this model.";
}
