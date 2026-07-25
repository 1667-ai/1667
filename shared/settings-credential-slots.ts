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
    addDocumentCredentialNames(document, names);
  }
  return [...names].sort();
}

function addDocumentCredentialNames(
  document: SettingsDocumentV2,
  names: Set<string>
): void {
  for (const connection of Object.values(document.connections)) {
    if (connection.auth.type !== "none") names.add(connection.auth.env);
    for (const header of connection.headers) names.add(header.value.env);
  }
}
