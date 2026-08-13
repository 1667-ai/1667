import {
  backspaceComposer,
  composerCellTextAt,
  composerLength,
  composerLineBounds,
  composerPosition,
  composerSelection,
  deleteComposerForward,
  moveComposerHorizontal,
  moveComposerTo,
  moveComposerVertical,
  redoComposerEdit,
  replaceComposerTextRange,
  undoComposerEdit,
  type ComposerState
} from "./composer-model.js";
import type { KeyAction } from "./keys.js";

export function moveComposerWord(
  composer: ComposerState, direction: -1 | 1, selecting = false
): void {
  const selection = composerSelection(composer);
  if (!selecting && selection !== null) {
    moveComposerTo(composer, direction < 0 ? selection.start : selection.end);
    return;
  }
  moveComposerTo(composer, wordBoundary(composer, composer.cursor, direction), selecting);
}

export function moveComposerLineBoundary(
  composer: ComposerState, end: boolean, selecting = false
): void {
  const bounds = composerLineBounds(composer, composerPosition(composer).line);
  moveComposerTo(composer, end ? bounds.end : bounds.start, selecting);
}

export function moveComposerBufferBoundary(
  composer: ComposerState, end: boolean, selecting = false
): void {
  moveComposerTo(composer, end ? composerLength(composer) : 0, selecting);
}

export function selectAllComposer(composer: ComposerState): void {
  composer.anchor = 0;
  moveComposerTo(composer, composerLength(composer), true);
}

export function deleteComposerWord(composer: ComposerState, direction: -1 | 1): void {
  const selection = composerSelection(composer);
  const boundary = selection === null
    ? wordBoundary(composer, composer.cursor, direction)
    : direction < 0 ? selection.start : selection.end;
  replaceComposerTextRange(composer,
    selection?.start ?? Math.min(composer.cursor, boundary),
    selection?.end ?? Math.max(composer.cursor, boundary), "");
}

export function deleteComposerLine(composer: ComposerState): void {
  const selection = composerSelection(composer);
  if (selection !== null) {
    replaceComposerTextRange(composer, selection.start, selection.end, "");
    return;
  }
  const position = composerPosition(composer);
  const bounds = composerLineBounds(composer, position.line);
  const start = bounds.nextStart === null && position.line > 0 ? bounds.start - 1 : bounds.start;
  replaceComposerTextRange(composer, start, bounds.nextStart ?? composerLength(composer), "");
}

export function deleteComposerToLineBoundary(composer: ComposerState, end: boolean): void {
  const selection = composerSelection(composer);
  if (selection !== null) {
    replaceComposerTextRange(composer, selection.start, selection.end, "");
    return;
  }
  const bounds = composerLineBounds(composer, composerPosition(composer).line);
  const boundary = end ? bounds.end : bounds.start;
  replaceComposerTextRange(composer,
    Math.min(composer.cursor, boundary), Math.max(composer.cursor, boundary), "");
}

/** Move by logical rows. Direct and one-line Settings editors do not soft-wrap.
 *  Returns whether the cursor actually moved, matching the soft-wrapped
 *  `moveComposerVisualRows` this stands in for. */
export function moveComposerPage(
  composer: ComposerState,
  direction: -1 | 1,
  rows: number,
  selecting = false
): boolean {
  const count = Math.max(1, Math.floor(rows));
  let moved = false;
  for (let row = 0; row < count; row += 1) {
    if (!moveComposerVertical(composer, direction, selecting)) break;
    moved = true;
  }
  return moved;
}

function wordBoundary(composer: ComposerState, cursor: number, direction: -1 | 1): number {
  const total = composerLength(composer);
  if (direction > 0) {
    let next = Math.max(0, Math.min(total, cursor));
    const category = cellCategory(composerCellTextAt(composer, next));
    while (next < total && cellCategory(composerCellTextAt(composer, next)) === category) next += 1;
    while (next < total && cellCategory(composerCellTextAt(composer, next)) === "space") next += 1;
    return next;
  }
  let previous = Math.max(0, Math.min(total, cursor));
  while (previous > 0 && cellCategory(composerCellTextAt(composer, previous - 1)) === "space") previous -= 1;
  const category = previous > 0 ? cellCategory(composerCellTextAt(composer, previous - 1)) : "space";
  while (previous > 0 && cellCategory(composerCellTextAt(composer, previous - 1)) === category) previous -= 1;
  return previous;
}

function cellCategory(text: string | null): "space" | "word" | "punctuation" {
  if (text === null || /^\s+$/u.test(text)) return "space";
  return /[\p{L}\p{N}_]/u.test(text) ? "word" : "punctuation";
}

export type ComposerEditKind = "move" | "delete" | "insert";

/**
 * Apply one editing action to a composer.
 * Return null when the caller must handle the action.
 *
 * The three composer-backed surfaces previously used separate logic.
 * The editor used `select-*` actions for selection.
 * Direct used the `extendSelection` flag for selection.
 * Each surface ignored the other selection form.
 *
 * This reducer is render-agnostic.
 * Vertical motion is render-dependent.
 * The editor uses `softWrap: true` and moves by wrapped visual line.
 * Direct does not wrap and moves by logical line.
 * Direct uses the vertical return value to start history navigation.
 */
export function applyComposerEdit(
  composer: ComposerState,
  action: KeyAction,
  extend = false
): ComposerEditKind | null {
  switch (action) {
    case "cursor-left": moveComposerHorizontal(composer, -1, extend); return "move";
    case "cursor-right": moveComposerHorizontal(composer, 1, extend); return "move";
    case "cursor-word-left": moveComposerWord(composer, -1, extend); return "move";
    case "cursor-word-right": moveComposerWord(composer, 1, extend); return "move";
    case "cursor-line-start": moveComposerLineBoundary(composer, false, extend); return "move";
    case "cursor-line-end": moveComposerLineBoundary(composer, true, extend); return "move";
    case "cursor-buffer-start": moveComposerBufferBoundary(composer, false, extend); return "move";
    case "cursor-buffer-end": moveComposerBufferBoundary(composer, true, extend); return "move";
    case "select-all": selectAllComposer(composer); return "move";
    case "backspace": backspaceComposer(composer); return "delete";
    case "delete-forward": deleteComposerForward(composer); return "delete";
    case "delete-word-left": deleteComposerWord(composer, -1); return "delete";
    case "delete-word-right": deleteComposerWord(composer, 1); return "delete";
    case "delete-line": deleteComposerLine(composer); return "delete";
    case "delete-line-start": deleteComposerToLineBoundary(composer, false); return "delete";
    case "delete-line-end": deleteComposerToLineBoundary(composer, true); return "delete";
    default: return null;
  }
}

/** Apply local text history. Null means that the action is not undo or redo. */
export function applyComposerHistoryEdit(
  composer: ComposerState,
  action: KeyAction
): boolean | null {
  if (action === "undo-edit") return undoComposerEdit(composer);
  if (action === "redo-edit") return redoComposerEdit(composer);
  return null;
}
