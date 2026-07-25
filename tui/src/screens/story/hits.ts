import { addHit, type HitRows, type HitTarget } from "../../hit.js";
import { visibleWidth, type FrameLine } from "./frame.js";

/** Register action metadata carried by the rendered segments themselves.
 * `from` is the frame row `lines[0]` was drawn on, for callers that composite
 * a band — the status bar — after the page rows. */
export function addInlineHits(
  lines: FrameLine[],
  hits: HitRows,
  accepts: (target: HitTarget) => boolean = () => true,
  from = 0
): void {
  for (const [row, line] of lines.entries()) {
    let left = 0;
    for (const part of line) {
      const right = left + visibleWidth(part.text);
      if (part.hit !== undefined && right > left && accepts(part.hit)) {
        addHit(hits, from + row, { target: part.hit, left, right });
      }
      left = right;
    }
  }
}
