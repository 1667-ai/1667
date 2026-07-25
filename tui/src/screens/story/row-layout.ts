import { chapterWord, extentLabel } from "../../chapter-model.js";
import type { KeyAction } from "../../keys.js";
import type {
  ChapterDividerRow,
  ChapterSummaryRow,
  StoryPart,
  StoryRow,
  StoryViewModel
} from "../../model.js";
import type { StoryScreenState, StreamView } from "../../state.js";
import {
  MAX_HUMAN_EDIT_RANGES,
  type StoryNode,
  type TextRange
} from "../../../../shared/types.js";
import { takeStrip } from "./density.js";
import {
  fitLine,
  segment,
  sliceFrame,
  truncate,
  visibleWidth,
  type DisplayRole,
  type FrameLine,
  type FrameSegment
} from "./frame.js";
import { wrapText, type ProseStyle, type StyleRun, type WrappedLine, type WrapCache } from "../../wrap.js";
import {
  registerNextDeadline,
  type FrameDeadlineCollector
} from "../../animation-deadline.js";
import { streamTrimBounds } from "../../stream-text.js";
import type { WrapContentIdentity } from "../../wrap.js";

export const STORY_GUTTER = 24;

export interface StoryRowLayout {
  height: number;
  stickyGutter: StickyStoryGutter | null;
  render(): FrameLine[];
}

export interface StoryPartWrapPlan {
  partId: string;
  width: number;
  text: string;
  runs: readonly StyleRun<ProseStyle>[];
  identity: WrapContentIdentity;
  stream: StreamView | null;
  appending: boolean;
  appendStart: number | null;
}

export interface StoryPartWrapInput {
  id: string;
  node: Pick<StoryNode, "text">;
  isSummary: boolean;
  humanSpans: readonly TextRange[];
}

export interface StickyStoryGutter {
  /** Natural row inside this layout; clamped to the visible part while scrolling. */
  start: number;
  lines: FrameLine[];
}

/** One row plan owns measurement and visible rendering. Fixed rows are real
 * frame lines; wrapped prose contributes exactly one output row per wrap. */
export function layoutStoryRow(
  row: StoryRow,
  rowIndex: number,
  allParts: StoryPart[],
  state: StoryScreenState,
  measure: number,
  narrow: boolean,
  cache: WrapCache<ProseStyle>,
  deadlines?: FrameDeadlineCollector
): StoryRowLayout {
  const focused = state.focusIndex === rowIndex;
  if (row.kind === "chapter-divider") {
    return fixedLayout(renderChapterDivider(row, measure, narrow, focused,
      state.chapterDeleteArmedId === row.break.id));
  }
  if (row.kind === "chapter-summary") {
    const expanded = state.expandedChapterSummaryIds.has(row.summary.id);
    const detail = expanded ? wrapText(row.summary.text ?? "", [], Math.max(12, measure - 2)) : [];
    return fixedLayout(renderChapterSummary(row, measure, narrow, focused, expanded, detail));
  }

  const prefixMask = (narrow ? 1 : 0) | (state.showInstructions ? 2 : 0) | (row.isSummary ? 4 : 0);
  const wrapWidth = measure - (row.isSummary ? 2 : 0);
  const stream = streamForPart(state.stream, row.id);
  const identityContext = wrapIdentityContext(row, state);
  const identity = storyPartWrapIdentity(
    row,
    stream,
    identityContext.settledLength,
    identityContext.source,
    stream
  );
  let prepared: ReturnType<typeof wrapPart> | null = null;
  const prepare = () => prepared ??= wrapPart(
    row,
    stream,
    measure,
    cache,
    identityContext
  );
  const wrapped = cache.lineCount(row.id, wrapWidth, row.node.text, identity)
    ?? prepare().wrapped.length;
  const streaming = stream !== null;
  const gutterRows = streaming && !narrow ? 2
    : focused && !narrow && !row.isSummary
      ? (row.siblingCount > 1 ? 2 : 1) + GUTTER_VERBS.length
      : 0;
  let prefix: FrameLine[] | null = null;
  const preparePrefix = () => prefix ??= partPrefix(
    row, rowIndex, allParts, state, measure, narrow, focused, streaming, prefixMask
  );
  const expandedPrompt = (prefixMask & 2) !== 0 && state.expandedPromptIds.has(row.id);
  const prefixRows = expandedPrompt ? preparePrefix().length : prefixHeight(prefixMask);
  const stickyGutter = focused && !narrow && !row.isSummary && !streaming
    ? {
        start: prefixRows,
        lines: Array.from({ length: gutterRows }, (_, lineIndex) =>
          gutterFor(row, true, false, lineIndex))
      }
    : null;
  return {
    height: prefixRows + Math.max(wrapped, gutterRows),
    stickyGutter,
    render: () => [
      ...preparePrefix(),
      ...renderPartBody(row, state, focused, narrow, prepare(), gutterRows, deadlines)
    ]
  };
}

export function renderChapterOneHeading(view: StoryViewModel, measure: number, narrow: boolean): FrameLine[] {
  const chapter = view.chapters[0]!;
  const title = chapter.title === "" ? "" : ` · ${chapter.title}`;
  const label = `CHAPTER ONE${title} · ${extentLabel(chapter)}`;
  return [prefixLine(narrow, [], [segment(centeredRule(label, measure), "chrome")])];
}

function fixedLayout(lines: FrameLine[]): StoryRowLayout {
  return { height: lines.length, stickyGutter: null, render: () => lines };
}

function renderChapterDivider(
  row: ChapterDividerRow,
  measure: number,
  narrow: boolean,
  focused: boolean,
  armed: boolean
): FrameLine[] {
  const title = row.openingChapter.title === "" ? "(untitled)" : row.openingChapter.title;
  const label = `CHAPTER ${chapterWord(row.openingChapter.number).toUpperCase()} · ${title} · ${extentLabel(row.openingChapter)}`;
  const gutter = focused ? [segment("▸ chapter", "focus / accent")] : [];
  const lines: FrameLine[] = [prefixLine(narrow, gutter, [segment(centeredRule(label, measure), "chrome")])];
  if (focused) lines.push(prefixLine(narrow, [], armed
    ? [actionHint("d confirms remove", "prune", "danger text"), segment(" · ", "danger text"), actionHint("esc keeps", "cancel", "danger text")]
    : [actionHint("e rename", "edit"), segment(" · ", "chrome"), actionHint("d remove", "prune"),
      segment(" · ", "chrome"), actionHint("r summarize chapter above", "regenerate")]));
  return lines;
}

function renderChapterSummary(
  row: ChapterSummaryRow,
  measure: number,
  narrow: boolean,
  focused: boolean,
  expanded: boolean,
  detail: ReturnType<typeof wrapText>
): FrameLine[] {
  const tokenLabel = `${row.summary.tokens.toLocaleString("en-US")} tok`;
  const status = row.chapter.stale ? "stale — chapter changed" : "✓ stands in";
  const label = `§ ch ${chapterWord(row.chapter.number).toLowerCase()} summary · ${tokenLabel} · ${status}`;
  const role = row.chapter.stale ? "focus / accent" : "summary";
  const lines: FrameLine[] = [prefixLine(narrow, focused ? [segment("▸ summary", "focus / accent")] : [], [segment(truncate(label, measure), role)])];
  if (expanded) {
    for (const line of detail) lines.push(prefixLine(narrow, [], [segment("  "), segment(line.text, "summary")]));
    lines.push(prefixLine(narrow, [], [segment("  prose untouched · summary only changes model context", "chrome")]));
  }
  if (focused) lines.push(prefixLine(narrow, [], [
    actionHint(`enter ${expanded ? "collapses" : "expands"}`, "compose"), segment(" · ", "chrome"),
    actionHint("e edit", "edit"), segment(" · ", "chrome"),
    actionHint(`r ${row.chapter.stale ? "refresh" : "re-summarize"}`, "regenerate")
  ]));
  return lines;
}

function partPrefix(
  part: StoryPart,
  rowIndex: number,
  allParts: StoryPart[],
  state: StoryScreenState,
  measure: number,
  narrow: boolean,
  focused: boolean,
  streaming: boolean,
  mask: number
): FrameLine[] {
  const lines: FrameLine[] = [];
  if ((mask & 1) !== 0) lines.push(renderBoundary(part, measure, focused, streaming));
  if ((mask & 2) !== 0) {
    lines.push(...renderPrompt(part, rowIndex, state.expandedPromptIds.has(part.id), measure, narrow));
  }
  if ((mask & 4) !== 0) {
    const previousSummary = allParts.slice(0, part.number - 1).findLastIndex((candidate) => candidate.isSummary);
    const start = previousSummary + 2;
    const end = part.number - 1;
    const rawWords = allParts.slice(start - 1, end).reduce((sum, candidate) => sum + candidate.stub.words, 0);
    const header = `§ summary · parts ${start}–${end} · ${rawWords.toLocaleString("en-US")} → ${part.stub.words} words · replaces the text above`;
    lines.push(prefixLine(narrow, narrow ? [] : [segment("◈", "summary")], [segment(truncate(header, measure), "summary")]));
  }
  return lines;
}

function prefixHeight(mask: number): number {
  return Number((mask & 1) !== 0) + Number((mask & 2) !== 0) + Number((mask & 4) !== 0);
}

function renderPrompt(
  part: StoryPart,
  rowIndex: number,
  expanded: boolean,
  measure: number,
  narrow: boolean
): FrameLine[] {
  const instruction = part.instruction.trim() || "continue";
  const hit = { kind: "prompt" as const, index: rowIndex, rowId: part.id };
  if (!expanded) {
    return [prefixLine(narrow, [], fitLine([
      segment("»", "accent · deep", hit),
      segment(" ", "chrome", hit),
      ...compactPromptSegments(part.id, instruction, hit)
    ], measure))];
  }
  const wrapped = wrapText(instruction, [], Math.max(1, measure - 2));
  return wrapped.map((line, index) => prefixLine(narrow, [], [
    segment(index === 0 ? "»" : " ", index === 0 ? "accent · deep" : "chrome", hit),
    segment(" ", "chrome", hit),
    storySegment(line.text, "chrome", `${part.id}:instruction`, instruction, line.start, hit)
  ]));
}

function compactPromptSegments(
  partId: string,
  instruction: string,
  hit: { kind: "prompt"; index: number; rowId: string }
): FrameLine {
  const lines = /\s*\n+\s*/g;
  const output: FrameLine = [];
  let cursor = 0;
  for (const match of instruction.matchAll(lines)) {
    const start = match.index;
    if (start > cursor) {
      output.push(storySegment(
        instruction.slice(cursor, start), "chrome",
        `${partId}:instruction`, instruction, cursor, hit
      ));
    }
    output.push(segment(" ⏎ ", "chrome", hit));
    cursor = start + match[0].length;
  }
  if (cursor < instruction.length) {
    output.push(storySegment(
      instruction.slice(cursor), "chrome",
      `${partId}:instruction`, instruction, cursor, hit
    ));
  }
  return output;
}

function renderPartBody(
  part: StoryPart,
  state: StoryScreenState,
  focused: boolean,
  narrow: boolean,
  prepared: ReturnType<typeof wrapPart>,
  gutterRows: number,
  deadlines?: FrameDeadlineCollector
): FrameLine[] {
  const { stream, appending, wrapped } = prepared;
  if (part.isSummary) {
    return wrapped.map((line) => prefixLine(narrow, [], [segment("  ", "summary"),
      ...styledWrapped(line, "summary", "summary", state, part, false, deadlines)]));
  }
  const streaming = stream !== null;
  const lines = wrapped.map((line, lineIndex) => prefixLine(narrow, gutterFor(part, focused, streaming, lineIndex),
    styledWrapped(line, focused ? "prose" : "prose · dim", focused ? "human edit" : "human edit dim",
      state, part, streaming && !appending, deadlines)));
  const proseTip = lines.length - 1;
  for (let lineIndex = lines.length; lineIndex < gutterRows; lineIndex += 1) {
    lines.push(prefixLine(narrow, gutterFor(part, focused, streaming, lineIndex), []));
  }
  // Machine insertion stays visually distinct from the writer's solid block.
  if (streaming && proseTip >= 0) lines[proseTip]!.push(segment("▏", "chrome"));
  return lines;
}

function wrapPart(
  part: StoryPart,
  stream: StreamView | null,
  measure: number,
  cache: WrapCache<ProseStyle>,
  identityContext: { source: object; settledLength: number }
) {
  const plan = storyPartWrapPlan(
    part,
    stream,
    measure,
    identityContext.settledLength,
    identityContext.source,
    stream
  );
  return {
    stream: plan.stream,
    appending: plan.appending,
    wrapped: cache.wrap(plan.partId, plan.width, plan.text, plan.runs, plan.identity)
  };
}

/** Canonical prose-wrap input shared by synchronous rows and cold prewarming. */
export function storyPartWrapPlan(
  part: StoryPartWrapInput,
  stream: StreamView | null,
  measure: number,
  settledLength = part.node.text.length,
  identitySource: object = part.node,
  streamIdentity: object | null = stream
): StoryPartWrapPlan {
  const appending = stream?.append === true;
  const text = part.node.text;
  // Wrapping aligns style boundaries while it already owns grapheme
  // segmentation. Keeping this raw avoids a second uninterruptible scan before
  // resumable cold work begins.
  const streamingStart = appending && text.length > settledLength
    ? Math.max(0, settledLength)
    : null;
  const runs: StyleRun<ProseStyle>[] = [];
  const spanCount = Math.min(part.humanSpans.length, MAX_HUMAN_EDIT_RANGES);
  for (let index = 0; index < spanCount; index += 1) {
    const range = part.humanSpans[index]!;
    const end = streamingStart === null ? range.end : Math.min(range.end, streamingStart);
    if (end > range.start) runs.push({ start: range.start, end, style: "human" });
  }
  if (streamingStart !== null) runs.push({ start: streamingStart, end: text.length, style: "streaming" });
  return {
    partId: part.id,
    width: measure - (part.isSummary ? 2 : 0),
    text,
    runs,
    identity: storyPartWrapIdentity(
      part,
      stream,
      settledLength,
      identitySource,
      streamIdentity
    ),
    stream,
    appending,
    appendStart: streamingStart
  };
}

/** O(1) content proof for immutable payload prose and one append-only stream.
 * The raw text remains on the plan for cold work, never for warm comparison. */
export function storyPartWrapIdentity(
  part: StoryPartWrapInput,
  stream: StreamView | null,
  settledLength: number,
  source: object,
  streamIdentity: object | null
): WrapContentIdentity {
  const appending = stream?.append === true;
  const streamingStart = appending && part.node.text.length > settledLength
    ? Math.max(0, settledLength)
    : null;
  const contentStream = stream === null
    || streamIdentity === null
    || appending && streamingStart === null
    ? null
    : streamIdentity;
  const bounds = contentStream === null
    ? { start: 0, end: 0 }
    : appending
      ? { start: 0, end: stream!.text.length }
      : streamTrimBounds(stream!);
  return {
    source,
    stream: contentStream,
    streamStart: bounds.start,
    streamEnd: bounds.end,
    textLength: part.node.text.length
  };
}

function wrapIdentityContext(
  part: StoryPart,
  state: StoryScreenState
): { source: object; settledLength: number } {
  const authoritative = state.payload.path[part.pathIndex];
  const source = authoritative?.id === part.id ? authoritative : state.payload;
  return {
    source,
    settledLength: authoritative?.id === part.id
      ? authoritative.text.length
      : part.node.text.length
  };
}

function streamForPart(stream: StreamView | null, partId: string): StreamView | null {
  return stream?.targetId === partId ? stream : null;
}

export interface GutterVerb { token: string | null; label: string; action: KeyAction }

export const GUTTER_VERBS: ReadonlyArray<readonly GutterVerb[]> = [
  [{ token: "␠", label: "continue", action: "continue" }, { token: "↵", label: "direct", action: "compose" }],
  [{ token: "r", label: "retake", action: "regenerate" }, { token: "R", label: "reprompt", action: "retake-with-prompt" }],
  [{ token: "w", label: "write", action: "write" }, { token: "e", label: "edit", action: "edit" }]
];

const GUTTER_VERB_COLUMN_GAP = 2;

function gutterVerbLabel(verb: GutterVerb): string {
  return verb.token === null ? verb.label : `${verb.token} ${verb.label}`;
}

/** Widest label in each menu column. Derived from the verbs themselves so a
 * relabelled verb re-measures instead of drifting out of its column. */
const GUTTER_VERB_COLUMNS: readonly number[] = GUTTER_VERBS.reduce<number[]>((columns, row) => {
  row.forEach((verb, index) => {
    columns[index] = Math.max(columns[index] ?? 0, visibleWidth(gutterVerbLabel(verb)));
  });
  return columns;
}, []);

/** Every verb row is padded to this one width. The gutter is right-aligned, so
 * a uniform width is what gives the menu a single left edge and a shared second
 * column instead of a different indent per row. */
const GUTTER_VERB_WIDTH = GUTTER_VERB_COLUMNS.reduce(
  (total, column, index) => total + column + (index === 0 ? 0 : GUTTER_VERB_COLUMN_GAP),
  0
);

function gutterVerbSegments(row: readonly GutterVerb[]): FrameLine {
  const line = row.flatMap((verb, index): FrameLine => {
    const label = gutterVerbLabel(verb);
    const pad = (GUTTER_VERB_COLUMNS[index] ?? 0) - visibleWidth(label);
    return [
      ...(index === 0 ? [] : [segment(" ".repeat(GUTTER_VERB_COLUMN_GAP))]),
      actionHint(label, verb.action),
      ...(pad > 0 ? [segment(" ".repeat(pad))] : [])
    ];
  });
  // Squaring the row off to the block width is what makes the right-aligned
  // gutter give every verb row the same left edge.
  return fitLine(line, GUTTER_VERB_WIDTH);
}

function gutterFor(part: StoryPart, focused: boolean, streaming: boolean, lineIndex: number): FrameLine {
  if (streaming) {
    if (lineIndex === 0) return [segment("⟳ writing", "focus / accent")];
    if (lineIndex === 1) return [actionHint("esc stops", "cancel")];
    return [];
  }
  if (focused) {
    if (lineIndex === 0 && part.siblingCount > 1) {
      return [segment(`¶ ${part.number} `, "chrome"), ...takeCounterSegments(part)];
    }
    if (lineIndex === 0) return part.isSummary
      ? [segment(`¶ ${part.number} `, "chrome"), segment("◈", "summary")]
      : [segment(`¶ ${part.number}`, "chrome")];
    if (part.siblingCount > 1 && lineIndex === 1) {
      const strip = takeStrip(part.takeIndex, part.siblingCount);
      const segments = stripSegments(strip, part.takeIndex, part.siblingCount);
      // Pad the strip out to the counter above it so the right-aligned gutter
      // starts both on the same column: the dots read as belonging to the
      // counter rather than as a third indent.
      const width = segments.reduce((sum, item) => sum + visibleWidth(item.text), 0);
      const pad = takeCounterWidth(part) - width;
      return pad > 0 ? [...segments, segment(" ".repeat(pad))] : segments;
    }
    if (!part.isSummary) {
      const verbs = GUTTER_VERBS[lineIndex - (part.siblingCount > 1 ? 2 : 1)];
      if (verbs !== undefined) return gutterVerbSegments(verbs);
    }
  }
  if (lineIndex === 0) {
    if (part.isSummary) return [segment("◈", "summary")];
    if (part.siblingCount > 1) return [segment(`×${part.siblingCount}`, "chrome")];
  }
  return [];
}

function takeCounterSegments(part: StoryPart): FrameLine {
  return [
    actionHint("‹", "take-previous", "focus / accent"),
    segment(` take ${part.takeIndex}/${part.siblingCount} `, "focus / accent"),
    actionHint("›", "take-next", "focus / accent")
  ];
}

function takeCounterWidth(part: StoryPart): number {
  return takeCounterSegments(part).reduce((sum, item) => sum + visibleWidth(item.text), 0);
}

function stripSegments(strip: ReturnType<typeof takeStrip>, currentTake: number, count: number): FrameLine {
  if (strip.density === "gauge") {
    return [
      segment(strip.text.slice(0, strip.currentOffset), "chrome"),
      segment(strip.text[strip.currentOffset] ?? "", "focus / accent",
        { kind: "story-take", take: currentTake }),
      segment(strip.text.slice(strip.currentOffset + 1), "chrome")
    ];
  }
  const spacing = strip.density === "spaced" ? " " : "";
  return Array.from({ length: count }, (_, index): FrameLine => [
    ...(index === 0 ? [] : [segment(spacing, "chrome")]),
    segment(index + 1 === currentTake ? "●" : "○",
      index + 1 === currentTake ? "focus / accent" : "chrome",
      { kind: "story-take", take: index + 1 })
  ]).flat();
}

/** Repaint only the fixed-width gutter; preserve cell-accurate prose segments. */
export function replaceStoryGutter(line: FrameLine, gutter: FrameLine, width: number): FrameLine {
  const prose = sliceFrame([line], STORY_GUTTER, Math.max(0, width - STORY_GUTTER))[0] ?? [];
  return prefixLine(false, gutter, prose);
}

function renderBoundary(part: StoryPart, measure: number, focused: boolean, streaming: boolean): FrameLine {
  if (streaming) {
    const lead = `── ¶ ${part.number} · ⟳ writing · `;
    const stop = "esc stops";
    const used = visibleWidth(lead) + visibleWidth(stop) + 1;
    return [segment("  "), segment(lead, "chrome"), actionHint(stop, "cancel"), segment(" ", "chrome"),
      segment("─".repeat(Math.max(0, measure - used)), "chrome")];
  }
  const marker = focused && part.siblingCount > 1
      ? `¶ ${part.number} · ${takeStrip(part.takeIndex, part.siblingCount).counter}`
      : part.siblingCount > 1
        ? `¶ ${part.number} · ×${part.siblingCount}`
      : `¶ ${part.number}${part.isSummary ? " · ◈" : ""}`;
  const prefix = `── ${marker} `;
  return [segment("  "), segment(prefix, "chrome"),
    segment("─".repeat(Math.max(0, measure - visibleWidth(prefix))), "chrome")];
}

function prefixLine(narrow: boolean, gutter: FrameLine, prose: FrameLine): FrameLine {
  if (narrow) return [segment("  "), ...prose];
  const gutterWidth = gutter.reduce((sum, item) => sum + visibleWidth(item.text), 0);
  return [segment(" ".repeat(Math.max(0, STORY_GUTTER - 1 - gutterWidth))), ...gutter, segment(" "), ...prose];
}

function styledWrapped(
  line: WrappedLine<ProseStyle>,
  resting: DisplayRole,
  human: DisplayRole,
  state: StoryScreenState,
  part: StoryPart,
  streaming = false,
  deadlines?: FrameDeadlineCollector
): FrameLine {
  const defaultRole = freshRole(state, part, resting, streaming, deadlines);
  const output: FrameLine = [];
  let cursor = 0;
  const sourceKey = `${part.id}:text`;
  for (const run of line.styleRuns) {
    if (run.start > cursor) {
      output.push(storySegment(
        line.text.slice(cursor, run.start), defaultRole,
        sourceKey, part.node.text, line.start + cursor
      ));
    }
    output.push(storySegment(
      line.text.slice(run.start, run.end), run.style === "human" ? human : "streaming",
      sourceKey, part.node.text, line.start + run.start
    ));
    cursor = run.end;
  }
  if (cursor < line.text.length) {
    output.push(storySegment(
      line.text.slice(cursor), defaultRole,
      sourceKey, part.node.text, line.start + cursor
    ));
  }
  if (line.text.length === 0) output.push(segment("", defaultRole));
  return output;
}

function storySegment(
  text: string,
  role: DisplayRole,
  key: string,
  sourceText: string,
  start: number,
  hit?: FrameSegment["hit"]
): FrameSegment {
  return {
    ...segment(text, role, hit),
    storySource: { key, text: sourceText, start }
  };
}

function freshRole(
  state: StoryScreenState,
  part: StoryPart,
  resting: DisplayRole,
  streaming: boolean,
  deadlines?: FrameDeadlineCollector
): DisplayRole {
  if (streaming) return "streaming";
  const landed = state.freshLandedAt.get(part.id);
  if (landed === undefined) return resting;
  const age = Math.max(0, state.now - landed);
  registerNextDeadline(deadlines, state.now, [landed + 330, landed + 660, landed + 1_000]);
  if (age < 330) return "streaming";
  if (age < 660) return "fresh 1";
  if (age < 1000) return "fresh 2";
  return resting;
}

function centeredRule(label: string, measure: number): string {
  const body = ` ${truncate(label, Math.max(1, measure - 6))} `;
  const remaining = Math.max(2, measure - visibleWidth(body));
  const left = Math.floor(remaining / 2);
  return `${"─".repeat(left)}${body}${"─".repeat(remaining - left)}`;
}

function actionHint(text: string, action: KeyAction, role: DisplayRole = "chrome"): FrameSegment {
  return segment(text, role, { kind: "inline-action", action });
}
