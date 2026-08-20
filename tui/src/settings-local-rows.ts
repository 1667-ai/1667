import type { SettingsRowId } from "./state.js";

/** Settings rows kept in the user config instead of the server-backed draft.
 *  One list, because both the overlay model and its reconciliation ask the same
 *  question, and a row that appears in only one of them reads as a draft change
 *  that never saves. This module holds no other state so that both can import
 *  it without depending on each other. */
export const LOCAL_CONFIG_ROWS = [
  "theme", "compose-focus", "word-wrap", "update-checks"
] as const;

export type LocalConfigRow = typeof LOCAL_CONFIG_ROWS[number];

export function settingsRowIsLocal(row: SettingsRowId): row is LocalConfigRow {
  return (LOCAL_CONFIG_ROWS as readonly SettingsRowId[]).includes(row);
}
