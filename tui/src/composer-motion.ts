import {
  composerPosition,
  moveComposerVertical,
  type ComposerState
} from "./composer-model.js";
import { moveComposerPage } from "./composer-editing.js";
import { moveComposerVisualRows } from "./composer-visual-movement.js";
import { wrappedComposerLayout } from "./composer-wrapping.js";

/** Vertical motion follows the paint: wrapped rows when a surface soft-wraps,
 *  logical lines when it does not. One policy, built once per surface from
 *  its own `wordWrap` setting, instead of each reducer re-deciding the same
 *  question with its own mechanism. */
export interface ComposerVerticalMotion {
  vertical(composer: ComposerState, direction: -1 | 1, selecting?: boolean): boolean;
  rows(composer: ComposerState, rows: number, selecting?: boolean): boolean;
  atFirstRow(composer: ComposerState): boolean;
}

/** `wrapWidth` is read lazily: a wrapped surface's field width can depend on
 *  live terminal geometry the caller only wants to resolve when a motion
 *  actually happens, not once up front for a policy that may go unused. */
export function composerMotion(
  softWrap: boolean,
  wrapWidth: () => number
): ComposerVerticalMotion {
  return softWrap ? wrappedMotion(wrapWidth) : logicalMotion();
}

function wrappedMotion(wrapWidth: () => number): ComposerVerticalMotion {
  return {
    vertical: (composer, direction, selecting) =>
      moveComposerVisualRows(composer, direction, wrapWidth(), selecting),
    rows: (composer, rows, selecting) =>
      moveComposerVisualRows(composer, rows, wrapWidth(), selecting),
    atFirstRow: (composer) => wrappedComposerLayout(composer, wrapWidth()).cursorRow === 0
  };
}

function logicalMotion(): ComposerVerticalMotion {
  return {
    vertical: (composer, direction, selecting) =>
      moveComposerVertical(composer, direction, selecting),
    rows: (composer, rows, selecting) =>
      moveComposerPage(composer, rows < 0 ? -1 : 1, Math.abs(rows), selecting),
    atFirstRow: (composer) => composerPosition(composer).line === 0
  };
}

/** Fields that are always single-line — a settings row edit, the library
 *  rename prompt, a sampling knob edit — never soft-wrap, regardless of the
 *  word-wrap setting. Shared so those surfaces do not each build their own. */
export const SINGLE_LINE_COMPOSER_MOTION: ComposerVerticalMotion = composerMotion(false, () => 0);
