import {
  applyStoredApiKeyEdit as applyStoredApiKeyEditCore,
  discardUnreferencedConnectionSecretWrites as discardUnreferencedConnectionSecretWritesCore,
  hasStoredApiKey as hasStoredApiKeyCore,
  rekeyPendingStoredSecret as rekeyPendingStoredSecretCore,
  type SettingsSecretSidecarState
} from "../../shared/settings-secret-sidecar.js";
import { replaceSettingsDraft } from "./settings-draft-transition.js";
import type { SettingsOverlayState } from "./state.js";

export { sameConnectionSecrets } from "../../shared/settings-secret-sidecar.js";

/** The overlay's draft and secrets as the shared sidecar state. A draft write
 * goes through `replaceSettingsDraft`, so model provenance stays in step. */
function sidecarOf(overlay: SettingsOverlayState): SettingsSecretSidecarState {
  return {
    get draft() { return overlay.draft; },
    set draft(next) { replaceSettingsDraft(overlay, next); },
    get secrets() { return overlay.connectionSecrets; },
    set secrets(next) { overlay.connectionSecrets = { ...next }; }
  };
}

export function applyStoredApiKeyEdit(
  overlay: SettingsOverlayState,
  value: string
): string | null {
  return applyStoredApiKeyEditCore(sidecarOf(overlay), value);
}

export function storedApiKeyPresentation(
  overlay: SettingsOverlayState
): string {
  return hasStoredApiKey(overlay) ? "•••••••• · stored" : "—";
}

export function hasStoredApiKey(overlay: SettingsOverlayState): boolean {
  return hasStoredApiKeyCore(sidecarOf(overlay));
}

export function rekeyPendingStoredSecret(overlay: SettingsOverlayState): void {
  rekeyPendingStoredSecretCore(sidecarOf(overlay));
}

export function discardUnreferencedConnectionSecretWrites(overlay: SettingsOverlayState): void {
  discardUnreferencedConnectionSecretWritesCore(sidecarOf(overlay));
}
