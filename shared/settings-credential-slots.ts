import type {
  SettingsDocumentV2,
  SettingsStateV2
} from "./settings-v2-types.js";

/**
 * Sorted credential union for every exact role-backed document. The parser
 * proves the document table is exactly active/pending/previous before this
 * projection runs, so rollback authority cannot be omitted.
 */
export function settingsStateCredentialNames(
  state: Pick<SettingsStateV2, "documents">
): string[] {
  const names = new Set<string>();
  for (const document of Object.values(state.documents)) {
    addDocumentCredentialNames(document, names, true);
  }
  return [...names].sort();
}

/** Environment-only projection for supervised process secret requests. */
export function settingsStateEnvironmentCredentialNames(
  state: Pick<SettingsStateV2, "documents">
): string[] {
  const names = new Set<string>();
  for (const document of Object.values(state.documents)) {
    addDocumentCredentialNames(document, names, false);
  }
  return [...names].sort();
}

function addDocumentCredentialNames(
  document: SettingsDocumentV2,
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
