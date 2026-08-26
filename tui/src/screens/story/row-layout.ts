import { chapterWord, extentLabel } from "../../chapter-model.js";
import type {
  ChapterDividerRow,
  ChapterSummaryRow,
  StoryPart,
  StoryRow,
  StoryViewModel
} from "../../model.js";
import type { StoryScreenState } from "../../state.js";
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
import { wrapText, type ProseStyle, type WrappedLine, type WrapCache } from "../../wrap.js";
import {
  registerNextDeadline,
  type FrameDeadlineCollector
} from "../../animation-deadline.js";
import { streamForPart } from "../../stream-text.js";
import { STORY_GUTTER } from "../../composer-geometry.js";
import { thoughtGutterContext, type ThoughtGutterContext } from "../../reasoning-model.js";
import { unfoldedThoughtBlock } from "./thought-block.js";
import {
  starterLogoSourceStart,
  storyPartWrapIdentity,
  wrapIdentityContext,
  wrapPart
} from "./wrap-plan.js";
import {
  actionHint,
  gutterFor,
  gutterRowsFor,
  streamingGutterRows,
  streamLivenessMark
} from "./gutter.js";
import { asideBoundaryLabel, asidePresenceForPart } from "../../aside-presence.js";

export interface StoryRowLayout {
  height: number;
  stickyGutter: StickyStoryGutter | null;
  stickyPrompt: StickyStoryPrompt | null;
  render(): FrameLine[];
}

export interface StickyStoryGutter {
  /** Natural row inside this layout; clamped to the visible part while scrolling. */
  start: number;
  lines: FrameLine[];
}

export interface StickyStoryPrompt {
  /** Rows this part paints, excluding the blank that separates it from the next. */
  partRows: number;
  /** Sticky prefix lines stacked from the viewport's own top row down. Every
   *  case but one is the compact prompt alone; a narrow, streaming take stacks
   *  the boundary row above it too (item D — the side gutter is off, so the
   *  boundary is the only place `writing`/`esc stops` lives). Rendered lazily:
   *  blocks the viewport never paints must not be prepared. */
  lines: Array<{ start: number; line: () => FrameLine }>;
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

  const wrapWidth = measure - (row.isSummary ? 2 : 0);
  const sourceStart = row.isSummary
    ? 0
    : starterLogoSourceStart(row.node.text, row.humanSpans, wrapWidth);
  const wrappedTextInput = sourceStart === 0 ? row.node.text : row.node.text.slice(sourceStart);
  const stream = streamForPart(state.stream, row.id);
  const streaming = stream !== null;
  const thought = thoughtGutterContext(row, rowIndex, state, streaming, stream);
  const asidePresence = asidePresenceForPart(state.payload, row);
  const prefixFlags: PartPrefixFlags = {
    boundary: narrow,
    prompt: state.showInstructions,
    summaryHeader: row.isSummary,
    thought: thought.kind === "shown" && !thought.folded
  };
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
    identityContext,
    sourceStart
  );
  const wrappedBody = cache.lineCount(row.id, wrapWidth, wrappedTextInput, identity)
    ?? prepare().wrapped.length;
  const wrapped = wrappedBody + (sourceStart === 0 ? 0 : 1);
  // Built once per row: `gutterRows.length` (below) and every per-line lookup
  // in `renderPartBody` both read this same list, so the row's gutter height
  // and its content can never drift apart the way two hand-derived formulas
  // could. Only computed when it will actually be used — the streaming
  // gutter's fixed 2-line pair (`gutterFor`, gutter.ts) takes priority over
  // this whenever both are true.
  const gutterRows = focused && !narrow && !streaming && !row.isSummary
    ? gutterRowsFor(row, thought, asidePresence)
    : null;
  const streamingRows = streaming && !narrow ? streamingGutterRows(row, thought, state.now, deadlines) : null;
  const gutterRowCount = streamingRows?.length ?? gutterRows?.length ?? 0;
  let prefix: FrameLine[] | null = null;
  const preparePrefix = () => prefix ??= partPrefix(
    row, rowIndex, allParts, state, measure, narrow, focused, streaming, prefixFlags, thought,
    asidePresence, deadlines
  );
  const expandedPrompt = prefixFlags.prompt && state.expandedPromptIds.has(row.id);
  // An unfolded thought block's height is as variable as an expanded
  // prompt's own wrap — neither fits the fixed `prefixHeight` formula, so
  // both fall back to measuring the real, fully-built prefix once.
  const needsMeasuredPrefix = expandedPrompt || prefixFlags.thought;
  const prefixRows = needsMeasuredPrefix ? preparePrefix().length : prefixHeight(prefixFlags);
  // Both gutters that can outlive their own rows stick: the focused menu,
  // and the streaming pair (`writing`/`esc stops`, or `thinking`/`T peeks`),
  // which otherwise scrolls off the top with the head of a take that has
  // grown taller than the viewport — the viewport follows the tail while
  // text lands, so that is exactly when the stop affordance is needed.
  // `gutterRows` is already null in every case but its own
  // `focused && !narrow && !row.isSummary` guard above — the streaming and
  // summary conditions there already exclude it — so it needs no extra guard
  // to serve as the non-streaming sticky source below.
  const stickyGutterLines = streaming && !narrow ? streamingRows : gutterRows;
  const stickyGutter: StickyStoryGutter | null = stickyGutterLines === null
    ? null
    : { start: prefixRows, lines: stickyGutterLines };
  const promptRowIndex = narrow ? 1 : 0;
  const partRows = prefixRows + Math.max(wrapped, gutterRowCount);
  // A narrow, streaming take has no side gutter to carry `writing`/`esc
  // stops` (`gutterAt` returns `[]` when narrow) — the boundary row is the
  // only place that text lives, so it sticks first; the compact prompt, if
  // shown, stacks under it on the next frame row.
  const stickyPromptLines: StickyStoryPrompt["lines"] = [];
  if (narrow && streaming) stickyPromptLines.push({ start: 0, line: () => preparePrefix()[0] ?? [] });
  if (prefixFlags.prompt && !expandedPrompt) {
    stickyPromptLines.push({ start: promptRowIndex, line: () => preparePrefix()[promptRowIndex] ?? [] });
  }
  const stickyPrompt: StickyStoryPrompt | null = stickyPromptLines.length > 0
    ? { partRows, lines: stickyPromptLines }
    : null;
  return {
    height: partRows,
    stickyGutter,
    stickyPrompt,
    render: () => [
      ...preparePrefix(),
      ...renderPartBody(
        row, state, focused, narrow, prepare(), gutterRowCount, gutterRows,
        thought, asidePresence, deadlines
      )
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
  return { height: lines.length, stickyGutter: null, stickyPrompt: null, render: () => lines };
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
    for (const line of detail) lines.push(prefixLine(narrow, [], [segment("  "), { ...segment(line.text, "summary"), prose: true }]));
    lines.push(prefixLine(narrow, [], [segment("  prose untouched · summary only changes model context", "chrome")]));
  }
  if (focused) lines.push(prefixLine(narrow, [], [
    actionHint(`enter ${expanded ? "collapses" : "expands"}`, "compose"), segment(" · ", "chrome"),
    actionHint("e edit", "edit"), segment(" · ", "chrome"),
    actionHint(`r ${row.chapter.stale ? "refresh" : "re-summarize"}`, "regenerate")
  ]));
  return lines;
}

/** The four independent rows a part's prefix can carry, named instead of
 *  packed into a bitmask — see `prefixHeight` for why `thought` is excluded
 *  from the sum every other field contributes to. */
interface PartPrefixFlags {
  readonly boundary: boolean;
  readonly prompt: boolean;
  readonly summaryHeader: boolean;
  readonly thought: boolean;
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
  prefix: PartPrefixFlags,
  thought: ThoughtGutterContext,
  asidePresence: ReturnType<typeof asidePresenceForPart>,
  deadlines?: FrameDeadlineCollector
): FrameLine[] {
  const lines: FrameLine[] = [];
  if (prefix.boundary) {
    lines.push(renderBoundary(part, measure, focused, streaming, asidePresence, state.now, deadlines));
  }
  if (prefix.prompt) {
    lines.push(...renderPrompt(part, rowIndex, state.expandedPromptIds.has(part.id), measure, narrow));
  }
  if (prefix.summaryHeader) {
    const previousSummary = allParts.slice(0, part.number - 1).findLastIndex((candidate) => candidate.isSummary);
    const start = previousSummary + 2;
    const end = part.number - 1;
    const rawWords = allParts.slice(start - 1, end).reduce((sum, candidate) => sum + candidate.stub.words, 0);
    const header = `§ summary · parts ${start}–${end} · ${rawWords.toLocaleString("en-US")} → ${part.stub.words} words · replaces the text above`;
    lines.push(prefixLine(narrow, narrow ? [] : [segment("◈", "summary")], [segment(truncate(header, measure), "summary")]));
  }
  // Above the prose, the same slot the expanded instruction renders in — see
  // `renderPrompt` above. Ordered after the summary header so reading order
  // stays "what the row is" → "what was asked" → "what the model thought" →
  // "what it wrote" — a summary take names itself before it says what led to
  // it. `prefix.thought` narrows `thought.kind` to `"shown"` by construction
  // (`layoutStoryRow` derives both from the same check), but the type system
  // has no way to know that, so the `kind` check below is the proof.
  if (prefix.thought && thought.kind === "shown") {
    for (const row of unfoldedThoughtBlock(thought.hit, measure, thought.resolved)) {
      lines.push(prefixLine(narrow, row.gutter, row.prose));
    }
  }
  return lines;
}

/** Sum of the prefix's fixed-height rows. `thought` is deliberately excluded:
 *  an unfolded thought block wraps to as many rows as its text needs, so its
 *  height is measured once from the real prefix (`needsMeasuredPrefix`,
 *  `layoutStoryRow`) rather than counted here. */
function prefixHeight(prefix: PartPrefixFlags): number {
  return Number(prefix.boundary) + Number(prefix.prompt) + Number(prefix.summaryHeader);
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
    output.push(segment(" ↵ ", "chrome", hit));
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
  gutterRowCount: number,
  gutterRows: readonly FrameLine[] | null,
  thought: ThoughtGutterContext,
  asidePresence: ReturnType<typeof asidePresenceForPart>,
  deadlines?: FrameDeadlineCollector
): FrameLine[] {
  const { stream, appending, wrapped, sourceStart, compactLogo } = prepared;
  if (part.isSummary) {
    return wrapped.map((line) => prefixLine(narrow, [], [segment("  ", "summary"),
      ...styledWrapped(line, "summary", "summary", "summary", state, part, false, deadlines)]));
  }
  const streaming = stream !== null;
  const lines: FrameLine[] = [];
  const gutterAt = (lineIndex: number): FrameLine => narrow
    ? []
    : gutterFor(part, streaming, lineIndex, thought, gutterRows, state.now, deadlines, asidePresence);
  if (compactLogo) {
    lines.push(prefixLine(
      narrow,
      gutterAt(0),
      compactStarterLogo(focused)
    ));
  }
  for (const line of wrapped) {
    const lineIndex = lines.length;
    lines.push(prefixLine(narrow, gutterAt(lineIndex),
      styledWrapped(line, focused ? "prose" : "prose · dim", focused ? "human edit" : "human edit dim",
        "rewritten", state, part, streaming && !appending, deadlines, sourceStart)));
  }
  const proseTip = lines.length - 1;
  for (let lineIndex = lines.length; lineIndex < gutterRowCount; lineIndex += 1) {
    lines.push(prefixLine(narrow, gutterAt(lineIndex), []));
  }
  // Machine insertion stays visually distinct from the writer's solid block.
  if (streaming && proseTip >= 0) lines[proseTip]!.push(segment("▏", "chrome"));
  // Reasoning is arriving and no prose has landed yet: the prose column
  // shows only the dim caret, on the row the `thinking` gutter line claims —
  // `wrapped` is empty (nothing to loop above), so nothing has planted the
  // caret yet the way the `proseTip` branch above just did for ordinary text.
  else if (streaming && thought.kind === "shown" && thought.thinking && lines.length > 0) {
    lines[0]!.push(segment("▏", "chrome"));
  }
  return lines;
}

function compactStarterLogo(focused: boolean): FrameLine {
  const roles = focused
    ? ["logo red", "logo yellow", "logo green", "logo violet"] as const
    : ["prose · dim", "prose · dim", "prose · dim", "prose · dim"] as const;
  return [..."1667"].map((digit, index) => segment(digit, roles[index]!));
}

/** Repaint only the fixed-width gutter; preserve cell-accurate prose segments. */
export function replaceStoryGutter(line: FrameLine, gutter: FrameLine, width: number): FrameLine {
  const prose = sliceFrame([line], STORY_GUTTER, Math.max(0, width - STORY_GUTTER))[0] ?? [];
  return prefixLine(false, gutter, prose);
}

/** Swap the prose column and leave the gutter alone. A sticky gutter can share
 *  the row, and it owns those cells. A narrow frame has no gutter to protect. */
export function replaceStoryProse(
  line: FrameLine,
  promptLine: FrameLine,
  narrow: boolean,
  width: number
): FrameLine {
  if (narrow) return promptLine;
  const gutter = sliceFrame([line], 0, STORY_GUTTER)[0] ?? [];
  const prose = sliceFrame([promptLine], STORY_GUTTER, Math.max(0, width - STORY_GUTTER))[0] ?? [];
  return [...gutter, ...prose];
}

function renderBoundary(
  part: StoryPart,
  measure: number,
  focused: boolean,
  streaming: boolean,
  asidePresence: ReturnType<typeof asidePresenceForPart>,
  now = 0,
  deadlines?: FrameDeadlineCollector
): FrameLine {
  if (streaming) {
    const lead = `── ¶ ${part.number} · ${streamLivenessMark(now, deadlines)} writing · `;
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
  const aside = asideBoundaryLabel(asidePresence);
  const prefix = `── ${marker}${aside === null ? "" : ` · ${aside}`} `;
  const fitted = truncate(prefix, Math.max(0, measure));
  return [segment("  "), segment(fitted, "chrome"),
    segment("─".repeat(Math.max(0, measure - visibleWidth(fitted))), "chrome")];
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
  rewritten: DisplayRole,
  state: StoryScreenState,
  part: StoryPart,
  streaming = false,
  deadlines?: FrameDeadlineCollector,
  sourceStart = 0
): FrameLine {
  const defaultRole = freshRole(state, part, resting, streaming, deadlines);
  const output: FrameLine = [];
  let cursor = 0;
  const sourceKey = `${part.id}:text`;
  for (const run of line.styleRuns) {
    if (run.start > cursor) {
      output.push(storySegment(
        line.text.slice(cursor, run.start), defaultRole,
        sourceKey, part.node.text, sourceStart + line.start + cursor
      ));
    }
    output.push(storySegment(
      line.text.slice(run.start, run.end), proseStyleRole(run.style, human, rewritten, resting),
      sourceKey, part.node.text, sourceStart + line.start + run.start
    ));
    cursor = run.end;
  }
  if (cursor < line.text.length) {
    output.push(storySegment(
      line.text.slice(cursor), defaultRole,
      sourceKey, part.node.text, sourceStart + line.start + cursor
    ));
  }
  if (line.text.length === 0) output.push({ ...segment("", defaultRole), prose: true });
  return output;
}

function proseStyleRole(
  style: ProseStyle,
  human: DisplayRole,
  rewritten: DisplayRole,
  resting: DisplayRole
): DisplayRole {
  if (style === "human") return human;
  // A rewritten span stays at full weight whether or not its row is
  // focused — like `summary`, it names a durable fact about the passage,
  // not the transient reading-position emphasis that dims everything else
  // in an unfocused row (see the `rewritten` alias, frame.ts).
  if (style === "rewritten") return rewritten;
  if (style === "streaming") return "streaming";
  return resting === "prose" ? style : resting;
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
    storySource: { key, text: sourceText, start },
    prose: true
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
