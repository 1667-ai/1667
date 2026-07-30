import {
  composerLineBounds,
  composerPosition,
  composerPreferredX,
  moveComposerVerticallyTo,
  type ComposerState
} from "./composer-model.js";
import {
  composerCellsBetween,
  composerColumnAtCells,
  moveComposerToVisualBoundary
} from "./composer-vertical-movement.js";
import { wrappedComposerLayout } from "./composer-wrapping.js";

/** Move through ordinary soft-wrapped composer rows. */
export function moveComposerVisualVertical(
  composer: ComposerState,
  direction: -1 | 1,
  width: number,
  selecting = false
): boolean {
  const layout = wrappedComposerLayout(composer, width);
  const nextRow = Math.max(
    0,
    Math.min(layout.rowCount - 1, layout.cursorRow + direction)
  );
  const current = layout.rowAt(layout.cursorRow)!;
  if (nextRow === layout.cursorRow) {
    return moveComposerToVisualBoundary(
      composer,
      current.sourceIndex,
      current.start,
      current.end,
      direction,
      selecting
    );
  }
  const cursor = composerPosition(composer);
  const target = layout.rowAt(nextRow)!;
  const wanted = composerPreferredX(
    composer,
    composerCellsBetween(
      composer,
      current.sourceIndex,
      current.start,
      cursor.column
    )
  );
  const column = composerColumnAtCells(
    composer,
    target.sourceIndex,
    target.start,
    target.end,
    wanted
  );
  moveComposerVerticallyTo(
    composer,
    composerLineBounds(composer, target.sourceIndex).start + column,
    selecting
  );
  return true;
}
