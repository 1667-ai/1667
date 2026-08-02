import type { HitRows } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { FilePathPrompt } from "../path-completion.js";
import { wrapText } from "../wrap.js";
import { boundedContent } from "./panel-table-layout.js";
import {
  panelHorizontalGeometry,
  placePanel,
  raisedSegment
} from "./overlay.js";
import {
  truncateTail,
  visibleWidth,
  type FrameComposition,
  type FrameLine
} from "./story/frame.js";

/** Candidate rows the panel shows before it names the remainder. */
const CANDIDATE_ROWS = 6;
const PANEL_WIDTH = 72;

export interface FilePromptPanelText {
  /** The panel title in the top rule. */
  readonly title: string;
  /** The label in the value column, already padded to the value gutter. */
  readonly fieldPrefix: string;
  /** The note under the value. It states the rule, so the panel never has to
   * read the file to draw itself. Omit it to leave the row empty. */
  readonly note?: string;
}

/** The panel every file-path import shares.
 *
 * File names and system errors are file-supplied. The choke point in `frame.ts`
 * projects control characters for every drawn surface, so this panel keeps the
 * exact path the filesystem needs and adds no projection of its own. */
export function renderFilePromptPanel(
  base: FrameLine[],
  prompt: FilePathPrompt,
  text: FilePromptPanelText,
  hitRows: HitRows,
  width: number,
  height: number,
  footerActions: ReadonlyArray<{ token: string; action: KeyAction }>
): FrameComposition {
  const contentWidth = panelHorizontalGeometry(width, PANEL_WIDTH).contentWidth;
  const valueWidth = Math.max(0, contentWidth - visibleWidth(text.fieldPrefix) - 1);
  const indent = " ".repeat(visibleWidth(text.fieldPrefix));
  const content: FrameLine[] = [[
    raisedSegment(text.fieldPrefix, "chrome"),
    raisedSegment(truncateTail(prompt.path, valueWidth), "streaming"),
    raisedSegment("█", "focus / accent")
  ]];

  if (prompt.candidates.length > 0) {
    const candidateWidth = Math.max(1, contentWidth - visibleWidth(indent));
    for (const candidate of prompt.candidates.slice(0, CANDIDATE_ROWS)) {
      content.push([
        raisedSegment(indent, "chrome"),
        raisedSegment(truncateTail(candidate, candidateWidth), "prose · dim")
      ]);
    }
    // A silent cut would read as "these are all the matches". Name the rest.
    const hidden = prompt.candidates.length - CANDIDATE_ROWS;
    if (hidden > 0) {
      content.push([
        raisedSegment(indent, "chrome"),
        raisedSegment(`… ${hidden} more`, "chrome")
      ]);
    }
  }

  // A failed apply after a tab leaves both on screen: the candidates say what
  // the writer can pick, and the error says why the last try did not work.
  // Hiding either one would answer half the question.
  if (prompt.error !== null) {
    content.push(...errorLines(prompt.error, contentWidth));
  } else if (prompt.candidates.length === 0 && text.note !== undefined) {
    content.push([
      raisedSegment(indent, "chrome"),
      raisedSegment(text.note, "prose · dim")
    ]);
  }

  return placePanel(
    base,
    text.title,
    boundedContent(content, contentWidth),
    "tab completes · ↵ imports · esc closes",
    width,
    height,
    PANEL_WIDTH,
    { rows: hitRows, targets: content.map(() => null), footerActions }
  );
}

function errorLines(error: string, contentWidth: number): FrameLine[] {
  const marker = "          · ";
  const continuation = "            ";
  const firstWidth = Math.max(1, contentWidth - visibleWidth(marker));
  return wrapText(error, [], firstWidth).map((line, index) => [
    raisedSegment(
      `${index === 0 ? marker : continuation}${line.text}`,
      "danger text"
    )
  ]);
}
