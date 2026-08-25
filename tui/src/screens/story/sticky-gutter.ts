import type { FrameLine } from "./frame.js";
import { replaceStoryGutter, type StickyStoryGutter } from "./row-layout.js";

export interface OwnedStickyGutter {
  rowIndex: number;
  partHeight: number;
  gutter: StickyStoryGutter;
}

/** Every sticky gutter the frame carries: the focused part's menu and the
 *  streaming part's `writing`/`thinking` pair, which live on different rows
 *  once the reader moves focus away from a running generation. */
export function stickStoryGutters(
  lines: FrameLine[],
  owners: number[],
  blockRows: number[],
  gutters: readonly OwnedStickyGutter[],
  width: number
): FrameLine[] {
  return gutters.reduce(
    (result, gutter) => stickOwnedGutter(result, owners, blockRows, gutter, width),
    lines
  );
}

/** CSS-sticky semantics inside a story part: stay at the viewport top while
 * that part scrolls, then leave with the part at its lower boundary. */
function stickOwnedGutter(
  lines: FrameLine[],
  owners: number[],
  blockRows: number[],
  focused: OwnedStickyGutter,
  width: number
): FrameLine[] {
  if (focused.gutter.lines.length === 0) return lines;
  const visible = owners.flatMap((owner, frameRow) =>
    owner === focused.rowIndex && (blockRows[frameRow] ?? focused.partHeight) < focused.partHeight
      ? [{ frameRow, blockRow: blockRows[frameRow]! }]
      : []);
  if (visible.length === 0) return lines;

  const firstVisible = visible[0]!.blockRow;
  const lastStart = focused.partHeight - focused.gutter.lines.length;
  const paintedStart = Math.min(Math.max(focused.gutter.start, firstVisible), lastStart);
  const frameRowByBlockRow = new Map(visible.map(({ frameRow, blockRow }) => [blockRow, frameRow]));
  const result = [...lines];

  // Remove the menu's natural copy before painting its clamped copy.
  for (let index = 0; index < focused.gutter.lines.length; index += 1) {
    const frameRow = frameRowByBlockRow.get(focused.gutter.start + index);
    if (frameRow !== undefined) result[frameRow] = replaceStoryGutter(result[frameRow]!, [], width);
  }
  for (const [index, gutterLine] of focused.gutter.lines.entries()) {
    const frameRow = frameRowByBlockRow.get(paintedStart + index);
    if (frameRow !== undefined) result[frameRow] = replaceStoryGutter(result[frameRow]!, gutterLine, width);
  }
  return result;
}
