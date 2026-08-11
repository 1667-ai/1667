import type { ModelConnectionV2 } from "./settings-v2-types.js";

/**
 * The structural shape both `settingsStateCredentialNames` and
 * `settingsStateEnvironmentCredentialNames` actually need: a document's
 * `connections`, nothing else. `SettingsDocumentV2` and `SettingsDocumentV3`
 * both satisfy this - `connections` is the identical type on both, only
 * `schemaVersion` and `models` differ, so a caller holding either document
 * version, or a state whose documents mix the two across a schema migration,
 * can call these functions without a cast. Do not re-narrow this back to
 * `SettingsDocumentV2`: that is exactly the mistake that let
 * server/settings-v3-state-validation.ts skip the state-wide credential
 * bound `server/settings-v2-state-validation.ts` enforces.
 */
export interface CredentialBearingSettingsDocument {
  readonly connections: Readonly<Record<string, ModelConnectionV2>>;
}

interface CredentialBearingSettingsState {
  readonly documents: Readonly<Record<string, CredentialBearingSettingsDocument>>;
}

/**
 * Sorted credential union for every exact role-backed document. The parser
 * proves the document table is exactly active/pending/previous before this
 * projection runs, so rollback authority cannot be omitted.
 */
export function settingsStateCredentialNames(
  state: CredentialBearingSettingsState
): string[] {
  const names = new Set<string>();
  for (const document of Object.values(state.documents)) {
    addDocumentCredentialNames(document, names, true);
  }
  return [...names].sort();
}

/** Environment-only projection for supervised process secret requests. */
export function settingsStateEnvironmentCredentialNames(
  state: CredentialBearingSettingsState
): string[] {
  const names = new Set<string>();
  for (const document of Object.values(state.documents)) {
    addDocumentCredentialNames(document, names, false);
  }
  return [...names].sort();
}

function addDocumentCredentialNames(
  document: CredentialBearingSettingsDocument,
  names: Set<string>,
  includeStored: boolean
): void {
  for (const connection of Object.values(document.connections)) {
    if (
      connection.auth.type === "bearer-env"
      || connection.auth.type === "header-env"
    ) names.add(connection.auth.env);
    else if (
      includeStored
      && (
        connection.auth.type === "bearer-stored"
        || connection.auth.type === "header-stored"
      )
    ) names.add(`stored:${connection.auth.secretId}`);
    for (const header of connection.headers) names.add(header.value.env);
  }
}
