import type { SettingsScalarRow } from "../../shared/settings-scalar.js";
import type { SettingsRowId } from "./state.js";

export * from "../../shared/settings-scalar.js";

const SCALAR_ROWS: ReadonlySet<SettingsRowId> = new Set<SettingsRowId>([
  "temperature",
  "max-tokens",
  "context-window"
]);

export function isSettingsScalarRow(row: SettingsRowId): row is SettingsScalarRow {
  return SCALAR_ROWS.has(row);
}
