/**
 * The Fact editor's fixed row order: tag, activation, keys, priority,
 * budget, then the body composer. Tab/Shift+Tab, vertical move, and the
 * layout's cursor row all used to re-encode this order by hand — see
 * tui/src/fact-editor-policy.ts and
 * tui/src/screens/story/fact-editor-layout.ts, which now derive their
 * neighbours and row indices from this one list instead.
 */
export const FACT_EDITOR_ROWS = ["tag", "activation", "keys", "secondary", "match", "scan", "chain", "priority", "budget", "body"] as const;

export type FactEditorRow = (typeof FACT_EDITOR_ROWS)[number];

/** The row one step up (-1) or down (1) from `row`; clamps at either end
 *  rather than wrapping, so repeated moves at an edge are a no-op. */
export function nextFactEditorRow(row: FactEditorRow, direction: -1 | 1): FactEditorRow {
  const at = FACT_EDITOR_ROWS.indexOf(row);
  const clamped = Math.max(0, Math.min(FACT_EDITOR_ROWS.length - 1, at + direction));
  return FACT_EDITOR_ROWS[clamped]!;
}
