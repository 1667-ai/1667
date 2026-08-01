import type { HitRows } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { OverlayState } from "../state.js";
import { plainTerminalText } from "../../../shared/terminal-text.js";
import { wrapText } from "../wrap.js";
import {
  boundedContent
} from "./panel-table-layout.js";
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

export function renderCardImportPanel(
  base: FrameLine[],
  state: Pick<OverlayState, "card"> & { hitRows: HitRows },
  width: number,
  height: number,
  footerActions: ReadonlyArray<{ token: string; action: KeyAction }>
): FrameComposition {
  // Card names, file names, and system errors are all file-supplied. The panel
  // is the display boundary, so every drawn string loses its control characters
  // here while the state keeps the exact path the filesystem needs.
  const overlay = state.card!;
  const horizontal = panelHorizontalGeometry(width, 72);
  const contentWidth = horizontal.contentWidth;
  const fieldPrefix = "  card    ";
  const valueWidth = Math.max(0, contentWidth - visibleWidth(fieldPrefix) - 1);
  const content: FrameLine[] = [[
    raisedSegment(fieldPrefix, "chrome"),
    raisedSegment(truncateTail(plainTerminalText(overlay.path), valueWidth), "streaming"),
    raisedSegment("█", "focus / accent")
  ]];

  if (overlay.candidates.length > 0) {
    const candidatePrefix = "            ";
    const candidateWidth = Math.max(1, contentWidth - visibleWidth(candidatePrefix));
    for (const candidate of overlay.candidates.slice(0, CANDIDATE_ROWS)) {
      content.push([
        raisedSegment(candidatePrefix, "chrome"),
        raisedSegment(truncateTail(plainTerminalText(candidate), candidateWidth), "prose · dim")
      ]);
    }
    // A silent cut would read as "these are all the matches". Name the rest.
    const hidden = overlay.candidates.length - CANDIDATE_ROWS;
    if (hidden > 0) {
      content.push([
        raisedSegment(candidatePrefix, "chrome"),
        raisedSegment(`… ${hidden} more`, "chrome")
      ]);
    }
  }
  if (overlay.error !== null) content.push(...errorLines(overlay.error, contentWidth));

  return placePanel(
    base,
    "import character card",
    boundedContent(content, contentWidth),
    "tab completes · ↵ imports · esc closes",
    width,
    height,
    72,
    { rows: state.hitRows, targets: content.map(() => null), footerActions }
  );
}

function errorLines(error: string, contentWidth: number): FrameLine[] {
  const marker = "          · ";
  const continuation = "            ";
  const firstWidth = Math.max(1, contentWidth - visibleWidth(marker));
  return wrapText(plainTerminalText(error), [], firstWidth).map((line, index) => [
    raisedSegment(
      `${index === 0 ? marker : continuation}${line.text}`,
      "danger text"
    )
  ]);
}
