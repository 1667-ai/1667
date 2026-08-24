import { ServiceError } from "./errors.js";
import { storedCredentialSecretId } from "../shared/settings-stored-credential.js";
import type { CredentialBearingSettingsDocument } from "../shared/settings-credential-slots.js";
import { storedSecretIdsInDocument, storedSecretIdsInState } from "./subscription-runtime.js";
import { isMintedSecretId } from "./settings-secret-ids.js";
import type { ModelConnectionV2 } from "../shared/settings-v2-types.js";

export function requireConnectionSecretsMatchDocument(
  document: CredentialBearingSettingsDocument,
  entries: readonly (readonly [string, string | null])[]
): void {
  const referenced = storedSecretIdsInDocument(document);
  for (const [secretId, value] of entries) {
    if (
      (value === null && referenced.has(secretId))
      || (value !== null && !referenced.has(secretId))
    ) {
      throw new ServiceError(
        400,
        "Settings secret sidecar does not match the document credential references.",
        "invalid_request"
      );
    }
  }
}

export function requireActiveSecretRebindingRekeyed(
  active: CredentialBearingSettingsDocument,
  submitted: CredentialBearingSettingsDocument,
  entries: readonly (readonly [string, string | null])[]
): void {
  for (const [secretId, value] of entries) {
    if (value === null) continue;
    const activeReferences = connectionsResolvingStoredSecret(active, secretId);
    if (activeReferences.length === 0) continue;
    const submittedReferences = connectionsResolvingStoredSecret(submitted, secretId);
    const rotationInPlace = activeReferences.every((reference) =>
      submittedReferences.some((candidate) =>
        sameActivatedCredentialTarget(reference, candidate)));
    if (!rotationInPlace) {
      throw new ServiceError(
        400,
        "A stored key for a changed credential target needs a new secret ID; the active settings still resolve this one.",
        "invalid_request"
      );
    }
  }
}

export function requireMintedSecretIntroduction(
  current: { readonly documents: Readonly<Record<string, CredentialBearingSettingsDocument>> },
  submitted: CredentialBearingSettingsDocument,
  entries: readonly (readonly [string, string | null])[]
): void {
  const known = storedSecretIdsInState(current);
  const supplied = new Set(
    entries.filter(([, value]) => value !== null).map(([secretId]) => secretId)
  );
  for (const secretId of storedSecretIdsInDocument(submitted)) {
    if (!isMintedSecretId(secretId)) continue;
    if (known.has(secretId) || supplied.has(secretId)) continue;
    throw new ServiceError(
      400,
      "A minted secret ID can only enter settings through the save that stores its key; store the key or reference an ID these settings already use.",
      "invalid_request"
    );
  }
}

export function newlyMintedSecretIds(
  current: { readonly documents: Readonly<Record<string, CredentialBearingSettingsDocument>> },
  entries: readonly (readonly [string, string | null])[]
): readonly string[] {
  const known = storedSecretIdsInState(current);
  const minted: string[] = [];
  for (const [secretId, value] of entries) {
    if (value === null || !isMintedSecretId(secretId) || known.has(secretId)) continue;
    minted.push(secretId);
  }
  return minted;
}

export function usesCredentialReferences(
  connection: ModelConnectionV2
): boolean {
  return connection.auth.type !== "none" || connection.headers.length > 0;
}

export function sameActivatedCredentialTarget(
  active: ModelConnectionV2,
  candidate: ModelConnectionV2
): boolean {
  return active.protocol === candidate.protocol
    && active.baseUrl === candidate.baseUrl
    && JSON.stringify(active.auth) === JSON.stringify(candidate.auth)
    && JSON.stringify(active.headers) === JSON.stringify(candidate.headers);
}

function connectionsResolvingStoredSecret(
  document: CredentialBearingSettingsDocument,
  secretId: string
): readonly ModelConnectionV2[] {
  return Object.values(document.connections).filter(
    (connection) => storedCredentialSecretId(connection.auth) === secretId
  );
}
