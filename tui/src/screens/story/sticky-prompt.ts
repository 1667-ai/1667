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
  const topLine = lines[0];
  const owner = owners[0];
  const blockRow = blockRows[0];
  if (topLine === undefined || owner === undefined || owner < 0 || blockRow === undefined) {
    return lines;
  }
  const prompt = stickyPrompts.get(owner);
  if (prompt === undefined) return lines;
  // Above its natural row the prompt is already on screen; at `partRows` only
  // the blank spacer is left, and a finished part must let its prompt go.
  if (blockRow <= prompt.start || blockRow >= prompt.partRows) return lines;
  const result = [...lines];
  result[0] = replaceStoryProse(topLine, prompt.line(), narrow, width);
  return result;
}

