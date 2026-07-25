import type {
  CredentialReferenceV2,
  SettingsDocumentV2,
  SettingsRoutePurpose
} from "./settings-v2-types.js";
import { selectSettingsRoute } from "./settings-route.js";

export function storedCredentialSecretId(
  auth: CredentialReferenceV2
): string | null {
  return auth.type === "bearer-stored" || auth.type === "header-stored"
    ? auth.secretId
    : null;
}

export function routeHasStoredCredential(
  document: SettingsDocumentV2,
  purpose: SettingsRoutePurpose = "default"
): boolean {
  return storedCredentialSecretId(
    selectSettingsRoute(document, purpose).connection.auth
  ) !== null;
}
