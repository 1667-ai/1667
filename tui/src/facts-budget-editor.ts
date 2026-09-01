import { MAX_STORY_FACTS_BUDGET_TOKENS } from "../../shared/fact-budget.js";
import { graphemeCells } from "./cell-width.js";
import { budgetTextIsDigitsOrEmpty } from "./fact-editor-draft.js";
import { addHit, type HitRows } from "./hit.js";
import type { DocumentEditorSession, InlineEditorTarget } from "./state.js";
import {
  hintItem,
  segment,
  visibleWidth,
  type FrameLine,
  type HintItem
} from "./screens/story/frame.js";
import type { KeyAction } from "./keys.js";

/** The one story scalar that is a bounded numeric field rather than a
 * document. Keep the target check in one place for the editor reducer,
 * renderer, and insertion policy. */
export type FactsBudgetEditor = Extract<DocumentEditorSession, { kind: "document" }> & {
  target: Extract<InlineEditorTarget, { kind: "story-scalar" }> & { field: "facts-budget" };
};

export function isFactsBudgetEditor(
  editor: DocumentEditorSession | null | undefined
): editor is FactsBudgetEditor {
  return editor?.kind === "document"
    && editor.target.kind === "story-scalar"
    && editor.target.field === "facts-budget";
}

/** Map each rendered composer cell to its raw grapheme offset. The compact
 * field keeps the broad row fallback for clicks outside the input chip. */
export function addFactsBudgetComposerHits(
  line: FrameLine | undefined,
  row: number,
  hits: HitRows
): void {
  let left = 0;
  let endpoint: { cursor: number; left: number } | null = null;
  for (const part of line ?? []) {
    if (part.composerStart === undefined) {
      left += visibleWidth(part.text);
      continue;
    }
    for (const [offset, cell] of graphemeCells(part.text).entries()) {
      const right = left + cell.width;
      if (right > left) {
        addHit(hits, row, {
          target: {
            kind: "composer",
            composerCursor: part.composerStart + offset
          },
          left,
          right
        });
      }
      endpoint = {
        cursor: part.composerStart + offset + 1,
        left: right
      };
      left = right;
    }
  }
  if (endpoint !== null) {
    addHit(hits, row, {
      target: { kind: "composer", composerCursor: endpoint.cursor },
      left: endpoint.left,
      right: endpoint.left + 1
    });
  }
}

/** Admission for the live field. Range and safe-integer checks stay in
 * `parseBudgetText`, which runs once on save for both budget editors. */
export function factsBudgetInsert(
  raw: string
): { text: string } | { blocked: string } {
  return budgetTextIsDigitsOrEmpty(raw)
    ? { text: raw }
    : { blocked: "facts budget accepts digits only" };
}

/** The bound is visible before the writer types, while the empty sentinel has
 * an explicit meaning instead of relying on a long prose placeholder. */
export const FACTS_BUDGET_STATUS =
  `1–${MAX_STORY_FACTS_BUDGET_TOKENS.toLocaleString("en-US")} tokens · empty = uncapped`;

function budgetFooterAction(
  token: string,
  action: KeyAction,
  rank = 0
): HintItem {
  return hintItem([segment(token, "chrome", { kind: "action", action })], rank);
}

/** Semantic footer controls use the same reducer as their keyboard names.
 * Ranks keep save and cancel visible on narrow terminals. */
export const FACTS_BUDGET_FOOTER_ACTIONS: readonly HintItem[] = [
  budgetFooterAction("enter save", "save-edit"),
  budgetFooterAction("ctrl+s save", "save-edit", 1),
  budgetFooterAction("clear", "delete-line", 2),
  budgetFooterAction("esc cancel", "cancel", 3)
];

/** Keep all core controls discoverable when the footer has only a narrow
 * budget. The full labels remain on ordinary terminals. */
export function factsBudgetFooterActions(width: number): readonly HintItem[] {
  if (width >= 48) return FACTS_BUDGET_FOOTER_ACTIONS;
  return [
    budgetFooterAction("↵/⌃s", "save-edit"),
    budgetFooterAction("clear", "delete-line", 1),
    budgetFooterAction("esc", "cancel")
  ];
}
