import {
  composerLineBounds,
  composerLineCell,
  moveComposerVerticallyTo,
  type ComposerState
} from "./composer-model.js";

/** At the first/last visual row, one arrow press still reaches that row's
 * logical boundary; only a second press reports that movement is exhausted. */
export function moveComposerToVisualBoundary(
  composer: ComposerState,
  sourceIndex: number,
  rowStart: number,
  rowEnd: number,
  direction: -1 | 1,
  selecting: boolean
): boolean {
  const boundary = composerLineBounds(composer, sourceIndex).start
    + (direction > 0 ? rowEnd : rowStart);
  if (composer.cursor === boundary) {
    if (!selecting) moveComposerVerticallyTo(composer, composer.cursor);
    return false;
  }
  moveComposerVerticallyTo(composer, boundary, selecting);
  return true;
}

export function composerCellsBetween(
  composer: ComposerState,
  line: number,
  start: number,
  end: number
): number {
  let width = 0;
  for (let column = start; column < end; column += 1) {
    width += composerLineCell(composer, line, column)?.width ?? 0;
  }
  return width;
}

export function composerColumnAtCells(
  composer: ComposerState,
  sourceIndex: number,
  start: number,
  end: number,
  wanted: number
): number {
  let width = 0;
  for (let column = start; column < end; column += 1) {
    const next = width + (composerLineCell(composer, sourceIndex, column)?.width ?? 0);
    if (next >= wanted) return next === wanted ? column + 1 : column;
    width = next;
  }
  return end;
}
