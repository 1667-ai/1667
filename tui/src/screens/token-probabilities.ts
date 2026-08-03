import type { FrameDeadlineCollector } from "../animation-deadline.js";
import type { HitRows } from "../hit.js";
import { gaugeFill } from "../rail.js";
import type { NextRequestEstimate } from "../request-projection.js";
import { createStoryViewModel, type StoryPart, type StoryViewModel } from "../model.js";
import type { StoryScreenState, TokenProbabilitiesViewerState } from "../state.js";
import {
  tokenDisplayGlyph,
  tokenProbabilityAlternativeRows,
  tokenProbabilityExcerpt,
  tokenProbabilitySpan,
  type TokenProbabilityAlternativeRow,
  type TokenProbabilityEmptyReason,
  type TokenProbabilityExcerptLine
} from "../token-probabilities-model.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";
import { renderStatus } from "./story/status.js";
import { renderConnectionBanner } from "./connection-banner.js";
import {
  fitLine,
  padCells,
  padStartCells,
  plainLine,
  segment,
  truncate,
  visibleWidth,
  type FrameLine,
  type FrameSegment
} from "./story/frame.js";

const TOKEN_COL = 10;
const P_COL = 6;
const LOGPROB_COL = 7;
const BAR_CELLS_WIDE = 15;
const BAR_CELLS_NARROW = 8;

/** Read-only viewer of one take's alternative tokens (issue #291 phase 4).
 *  Keeps the story's own status bar — unlike the map, search, or request
 *  viewer, which replace it with their own breadcrumb — because knowing
 *  which model produced the numbers on screen is part of reading them. */
export function renderTokenProbabilitiesScreen(
  state: StoryScreenState,
  probs: TokenProbabilitiesViewerState,
  estimate: NextRequestEstimate,
  width: number,
  height: number,
  deadlines?: FrameDeadlineCollector
) {
  const hitRows: HitRows = Array.from({ length: height }, () => null);
  const view = createStoryViewModel(state.payload, state.stream);
  const part = view.parts.find((candidate) => candidate.id === probs.nodeId) ?? null;
  const narrow = width < 100;
  const body = part === null
    ? messageBody("This take is no longer part of the story.", width)
    : probs.loading
      ? messageBody("Loading token probabilities…", width)
      : probs.record === null
        ? emptyBody(probs.empty ?? { text: "This take has no token probabilities." }, width)
        : populatedBody(probs, part, probs.record, width, barCellsFor(width));
  const header = headerLine(state, view, part, probs, width);
  const keys = keylineRow(width);
  const status = fitLine(renderStatus(state, view, width, narrow, estimate), width);
  const rows: FrameLine[] = [header, [], ...body, [], keys, status];
  const padded = rows.slice(0, height);
  while (padded.length < height) padded.push([]);
  const lines = padded.map((line) => fitLine(line, width));
  return {
    lines: state.connection.down
      ? renderConnectionBanner(lines, { ...state, hitRows }, width, deadlines)
      : lines,
    selectable: null,
    derived: {
      hitRows,
      viewScroll: state.viewScroll,
      viewScrollDelta: state.viewScrollDelta,
      lastViewportStart: state.lastViewportStart,
      composerScrollTop: state.composerScrollTop,
      editorScrollTop: state.editorScrollTop,
      keysScrollTop: state.keysScrollTop,
      composerSelectionProjection: null,
      storySelectionProjection: null,
      map: state.map,
      request: state.request
    }
  };
}

function messageBody(text: string, width: number): FrameLine[] {
  return [[], fitLine([segment(text, "prose · dim")], width)];
}

function emptyBody(reason: TokenProbabilityEmptyReason, width: number): FrameLine[] {
  const lines: FrameLine[] = [[], fitLine([segment(reason.text, "prose")], width)];
  if (reason.supportedPresets !== undefined && reason.supportedPresets.length > 0) {
    lines.push([], fitLine(
      [segment(`presets that do support it: ${reason.supportedPresets.join(", ")}`, "chrome")],
      width
    ));
  }
  return lines;
}

/** C-08's own degradation rule: a 15-cell track at full width, 8 cells once
 *  the page can no longer spare that, and dropped outright below 80 —
 *  applied here to C-22's meter, since neither component names a bar width
 *  of its own and this is the one the design already ships elsewhere. */
function barCellsFor(width: number): number | null {
  if (width >= 100) return BAR_CELLS_WIDE;
  if (width >= 80) return BAR_CELLS_NARROW;
  return null;
}

function populatedBody(
  probs: TokenProbabilitiesViewerState,
  part: StoryPart,
  record: NonNullable<TokenProbabilitiesViewerState["record"]>,
  width: number,
  barCells: number | null
): FrameLine[] {
  const tokenIndex = Math.max(0, Math.min(record.steps.length - 1, probs.tokenIndex));
  const step = record.steps[tokenIndex];
  const measure = Math.max(20, width - 4);
  const span = tokenProbabilitySpan(record, tokenIndex);
  const excerpt = tokenProbabilityExcerpt(part.node.text, span, measure);
  const lines: FrameLine[] = excerpt.lines.map((line, index) => fitLine(
    excerptRow(
      line,
      index === 0 && excerpt.truncatedStart,
      index === excerpt.lines.length - 1 && excerpt.truncatedEnd
    ),
    width
  ));
  if (step === undefined) return lines;
  lines.push([]);
  lines.push(fitLine(
    sectionRule(`alternatives · token ${tokenIndex + 1} of ${record.steps.length}`, width),
    width
  ));
  lines.push(fitLine(columnHeader(barCells), width));
  const rows = tokenProbabilityAlternativeRows(step, probs.expanded);
  const altIndex = Math.max(0, Math.min(rows.length - 1, probs.altIndex));
  rows.forEach((row, index) => {
    lines.push(fitLine(alternativeRow(row, index === altIndex, barCells), width));
  });
  lines.push(fitLine([segment("─".repeat(Math.max(0, width)), "chrome")], width));
  return lines;
}

function headerLine(
  state: StoryScreenState,
  view: StoryViewModel,
  part: StoryPart | null,
  probs: TokenProbabilitiesViewerState,
  width: number
): FrameLine {
  const leafId = state.payload.path.at(-1)?.id ?? null;
  const tag = state.payload.tags.find((candidate) => candidate.nodeId === leafId) ?? null;
  const crumb = part === null
    ? ""
    : part.siblingCount > 1
      ? `¶ ${part.number} · take ${part.takeIndex}/${part.siblingCount}`
      : `¶ ${part.number}`;
  const trailing = probs.record === null ? "" : `logprobs · top ${probs.record.requested}`;
  const left: FrameSegment[] = [segment("━━ token probabilities ", "focus / accent")];
  if (tag !== null) {
    left.push(
      segment("━━ ", "chrome"),
      segment(`${tagGlyph(tag.status)} ${tag.name}`, tagRole(tag)),
      segment(" ", "chrome")
    );
  }
  if (crumb.length > 0) left.push(segment(`━━ ${crumb} `, "chrome"));
  const leftWidth = visibleWidth(plainLine(left));
  const trailingText = trailing.length === 0 ? "" : `${trailing} `;
  const fillWidth = Math.max(1, width - leftWidth - visibleWidth(trailingText));
  return fitLine([...left, segment("━".repeat(fillWidth), "chrome"), segment(trailingText, "chrome")], width);
}

function keylineRow(width: number): FrameLine {
  return fitLine([
    segment("←→", "focus / accent"), segment(" token · ", "chrome"),
    segment("↑↓", "focus / accent"), segment(" alternatives · ", "chrome"),
    segment("⇥", "focus / accent"), segment(" next ¶ · ", "chrome"),
    segment("esc", "focus / accent"), segment(" back", "chrome")
  ], width);
}

function sectionRule(text: string, width: number): FrameLine {
  const prefix = `── ${text} `;
  return [
    segment(prefix, "focus / accent"),
    segment("─".repeat(Math.max(0, width - visibleWidth(prefix))), "chrome")
  ];
}

function columnHeader(barCells: number | null): FrameLine {
  // Matches alternativeRow's own spacing exactly: one cell either side of
  // the bar when one is drawn, or the single cell that survives its place
  // once the bar itself is dropped.
  const barGap = barCells === null ? " " : " ".repeat(barCells + 2);
  return [
    segment("  ", "chrome"),
    segment(padCells("token", TOKEN_COL), "chrome"),
    segment(" ", "chrome"),
    segment(padCells("p", P_COL), "chrome"),
    segment(barGap, "chrome"),
    segment("logprob", "chrome")
  ];
}

function alternativeRow(
  row: TokenProbabilityAlternativeRow,
  selected: boolean,
  barCells: number | null
): FrameLine {
  const cursor = selected ? "▸ " : "  ";
  if (row.kind === "collapsed") {
    return [
      segment(cursor, "focus / accent"),
      segment(`${row.hiddenCount} more under 1 %`, "prose · dim"),
      segment(" — ↓ shows them", "chrome")
    ];
  }
  const tokenText = padCells(truncate(tokenDisplayGlyph(row.token), TOKEN_COL), TOKEN_COL);
  const pText = padCells(row.p.toFixed(3), P_COL);
  const logprobText = padStartCells(row.logprob.toFixed(3), LOGPROB_COL);
  const line: FrameLine = [
    segment(cursor, selected ? "focus / accent" : "chrome"),
    segment(tokenText, selected ? "prose" : "prose · dim"),
    segment(" ", "chrome"),
    segment(pText, "prose")
  ];
  if (barCells !== null) {
    const ink = gaugeFill(row.p, barCells);
    line.push(
      segment(" ", "chrome"),
      segment("▮".repeat(ink), "focus / accent"),
      segment("▯".repeat(barCells - ink), "chrome"),
      segment(" ", "chrome")
    );
  } else {
    line.push(segment(" ", "chrome"));
  }
  line.push(segment(logprobText, "prose · dim"));
  if (row.sampled) line.push(segment("   ✓ sampled", "focus / accent"));
  return line;
}

function excerptRow(
  line: TokenProbabilityExcerptLine,
  leadingEllipsis: boolean,
  trailingEllipsis: boolean
): FrameLine {
  const run = line.styleRuns[0];
  const segments: FrameSegment[] = [];
  if (leadingEllipsis) segments.push(segment("…", "prose · dim"));
  if (run === undefined) {
    segments.push(segment(line.text, "prose"));
  } else {
    const before = line.text.slice(0, run.start);
    const middle = line.text.slice(run.start, run.end);
    const after = line.text.slice(run.end);
    if (before.length > 0) segments.push(segment(before, "prose"));
    if (middle.length > 0) {
      segments.push({ text: tokenDisplayGlyph(middle), role: "background", background: "focus / accent", bold: true });
    }
    if (after.length > 0) segments.push(segment(after, "prose"));
  }
  if (trailingEllipsis) segments.push(segment("…", "prose · dim"));
  return segments;
}
