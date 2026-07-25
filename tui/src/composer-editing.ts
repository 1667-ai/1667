import {
  composerCellTextAt,
  composerLength,
  composerLineBounds,
  composerPosition,
  composerSelection,
  moveComposerTo,
  replaceComposerTextRange,
  type ComposerState
} from "./composer-model.js";

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
