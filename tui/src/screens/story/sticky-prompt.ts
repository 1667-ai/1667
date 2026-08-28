import type { FrameLine } from "./frame.js";
import { replaceStoryProse, type StickyStoryPrompt } from "./row-layout.js";

/** CSS-sticky semantics for the one-line prompt above a part: it sits in its
 * natural place until the part scrolls under it, holds the viewport's top row
 * while the part is still being read, and leaves with the part.
 *
 * Without this, a part taller than the terminal takes its own prompt off screen
 * — and the prompt is the one thing that says why the prose below it exists. */
export function stickStoryPrompt(
  lines: FrameLine[],
  owners: number[],
  blockRows: number[],
  stickyPrompts: Map<number, StickyStoryPrompt>,
  narrow: boolean,
  width: number
): FrameLine[] {
  const owner = owners[0];
  if (owner === undefined || owner < 0) return lines;
  const prompt = stickyPrompts.get(owner);
  if (prompt === undefined) return lines;
  let result: FrameLine[] | null = null;
  // One entry paints frame row `index`: today's lone prompt at row 0, or (item
  // D) a narrow streaming take's boundary row at 0 with the prompt stacked at
  // row 1 beneath it — both painted only while the viewport is still inside
  // this part (`blockRows[index]` between the entry's natural row and where
  // the part ends).
  for (const [index, entry] of prompt.lines.entries()) {
    const topLine = lines[index];
    const blockRow = blockRows[index];
    if (topLine === undefined || owners[index] !== owner || blockRow === undefined) continue;
    // Above its natural row the entry is already on screen; at `partRows`
    // only the blank spacer is left, and a finished part must let it go.
    if (blockRow <= entry.start || blockRow >= prompt.partRows) continue;
    result ??= [...lines];
    result[index] = replaceStoryProse(topLine, entry.line(), narrow, width);
  }
  return result ?? lines;
}

