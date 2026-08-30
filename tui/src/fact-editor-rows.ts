import type { FactEditorSession } from "./state.js";

/** Full Fact editor order. Simple mode projects the same order to Name, Tag,
 * and Body; one list keeps hidden advanced rows out of navigation. */
export const FACT_EDITOR_ROWS = ["name", "tag", "activation", "keys", "secondary", "match", "scan", "chain", "priority", "budget", "body"] as const;

export type FactEditorRow = (typeof FACT_EDITOR_ROWS)[number] | "scope";

export const FACT_EDITOR_SIMPLE_ROWS: readonly FactEditorRow[] = ["name", "tag", "body"];

/** Any non-default advanced value keeps the advanced panel visible in Simple
 * mode so an existing setting never disappears from the editor. */
export function factEditorAdvancedPinned(
  editor: Pick<FactEditorSession, "activation" | "keys" | "secondary" | "secondaryMode" | "scan" | "recursion" | "priority" | "budget">
): boolean {
  return editor.activation !== "always"
    || editor.keys.text.trim().length > 0
    || editor.secondary.text.trim().length > 0
    || editor.secondaryMode !== "and"
    || editor.scan.text.trim().length > 0
    || editor.recursion !== "on"
    || editor.priority !== "normal"
    || editor.budget.text.trim().length > 0;
}

export function factEditorVisibleRows(
  editor: Pick<FactEditorSession, "activation" | "keys" | "secondary" | "secondaryMode" | "scan" | "recursion" | "priority" | "budget">,
  viewMode: "simple" | "advanced",
  includeScope = false
): readonly FactEditorRow[] {
  const rows = viewMode === "advanced" || factEditorAdvancedPinned(editor)
    ? FACT_EDITOR_ROWS
    : FACT_EDITOR_SIMPLE_ROWS;
  if (!includeScope) return rows;
  const tag = rows.indexOf("tag");
  return [...rows.slice(0, tag + 1), "scope", ...rows.slice(tag + 1)];
}

/** The row one step up (-1) or down (1) from `row`; clamps at either end. */
export function nextFactEditorRow(
  row: FactEditorRow,
  direction: -1 | 1,
  rows: readonly FactEditorRow[] = FACT_EDITOR_ROWS
): FactEditorRow {
  const at = rows.indexOf(row);
  const origin = at < 0 ? (direction < 0 ? rows.length : -1) : at;
  const clamped = Math.max(0, Math.min(rows.length - 1, origin + direction));
  return rows[clamped]!;
}
