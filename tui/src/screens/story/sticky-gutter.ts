import type { FrameLine } from "./frame.js";
import { replaceStoryGutter, type StickyStoryGutter } from "./row-layout.js";

export interface FocusedStickyGutter {
  rowIndex: number;
  partHeight: number;
  gutter: StickyStoryGutter;
}

/** CSS-sticky semantics inside a story part: stay at the viewport top while
 * that part scrolls, then leave with the part at its lower boundary. */
export function stickFocusedGutter(
  lines: FrameLine[],
  owners: number[],
  blockRows: number[],
  focused: FocusedStickyGutter | null,
  width: number
): FrameLine[] {
  if (focused === null || focused.gutter.lines.length === 0) return lines;
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
