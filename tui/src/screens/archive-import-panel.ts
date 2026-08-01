import type { HitRows } from "../hit.js";
import type { KeyAction } from "../keys.js";
import type { OverlayState } from "../state.js";
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

export function renderArchiveImportPanel(
  base: FrameLine[],
  state: Pick<OverlayState, "archive"> & { hitRows: HitRows },
  width: number,
  height: number,
  footerActions: ReadonlyArray<{ token: string; action: KeyAction }>
): FrameComposition {
  // File names and system errors are file-supplied. The choke point in
  // frame.ts projects control characters while state keeps the exact path.
  const overlay = state.archive!;
  const horizontal = panelHorizontalGeometry(width, 72);
  const contentWidth = horizontal.contentWidth;
  const fieldPrefix = "  file    ";
  const valueWidth = Math.max(0, contentWidth - visibleWidth(fieldPrefix) - 1);
  const content: FrameLine[] = [[
    raisedSegment(fieldPrefix, "chrome"),
    raisedSegment(truncateTail(overlay.path, valueWidth), "streaming"),
    raisedSegment("█", "focus / accent")
  ]];

  if (overlay.candidates.length > 0) {
    const candidatePrefix = "            ";
    const candidateWidth = Math.max(1, contentWidth - visibleWidth(candidatePrefix));
    for (const candidate of overlay.candidates.slice(0, CANDIDATE_ROWS)) {
      content.push([
        raisedSegment(candidatePrefix, "chrome"),
        raisedSegment(truncateTail(candidate, candidateWidth), "prose · dim")
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
  } else if (overlay.error !== null) {
    content.push(...errorLines(overlay.error, contentWidth));
  } else {
    content.push([
      raisedSegment("          ", "chrome"),
      raisedSegment(
        ".lorebook → Facts here · .scenario · .story → a new story",
        "prose · dim"
      )
    ]);
  }

  return placePanel(
    base,
    "import archive",
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
  return wrapText(error, [], firstWidth).map((line, index) => [
    raisedSegment(
      `${index === 0 ? marker : continuation}${line.text}`,
      "danger text"
    )
  ]);
}
