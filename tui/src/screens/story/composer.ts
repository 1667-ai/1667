import {
  composerLineCell,
  composerLineCount,
  composerLineHasBreak,
  composerLineLength,
  composerLineSelection,
  composerLineSlice,
  composerLineStart,
  composerPosition,
  type ComposerState
} from "../../composer-model.js";
import {
  wrappedComposerLayout,
  type WrappedComposerRow
} from "../../composer-wrapping.js";
import {
  renderComposerLineBreak,
  renderComposerRange
} from "./composer-selection-render.js";
import {
  composerFieldLine,
  composerTitle,
  renderComposerFooter,
  renderComposerTop,
  type ComposerStatus
} from "./composer-chrome.js";
import {
  fitLine,
  segment,
  splitFrame,
  visibleWidth,
  type DisplayRole,
  type FrameLine
} from "./frame.js";

export type ComposerCaret = "focused" | "unfocused" | "streaming";

export interface ComposerLayoutOptions {
  composer: ComposerState;
  /** Select full-screen geometry for a surface that owns the whole viewport. */
  fullscreen?: boolean;
  terminalWidth: number;
  terminalHeight: number;
  /** Width of the inline story measure, excluding `indent`. */
  measure: number;
  indent?: string;
  composeMaxHeight?: number | null;
  directingPart?: number | null;
  caret?: ComposerCaret;
  /** Replaces the action hints without changing the fullscreen row budget. */
  footerNotice?: string | null;
  /** First logical row from the previous frame, retained until focus exits it. */
  scrollTop?: number | null;
  focusDim?: boolean;
  narrow?: boolean;
  /** Enter commits a retake of an existing part, so the footer relabels. */
  retaking?: boolean;
  /** Alternate copy for the shared in-TUI document editor. */
  title?: string;
  /** Optional top-rule status. The normal inline line counter remains the default. */
  status?: ComposerStatus;
  footerHints?: string;
  placeholder?: string;
  /** Break long source lines into visual rows instead of horizontally clipping. */
  softWrap?: boolean;
}

export interface ComposerLayout {
  lines: FrameLine[];
  /** Logical draft lines, including the empty initial line. */
  lineCount: number;
  /** Configured/formula cap for inline draft rows. */
  cap: number;
  /** Number of draft rows painted in this frame. */
  bodyRows: number;
  /** First logical draft line painted. */
  scrollTop: number;
  /** Cursor row relative to the first painted draft row. */
  cursorViewportRow: number;
  fieldWidth: number;
  fullscreen: boolean;
  dimsStory: boolean;
}

/** The default cap from design §11. A valid override is taken literally. */
export function composerHeightCap(terminalHeight: number, override?: number | null): number {
  if (override !== null && override !== undefined && Number.isFinite(override) && override >= 1) {
    return Math.floor(override);
  }
  return Math.max(6, Math.floor(Math.max(0, terminalHeight) / 3));
}

/**
 * Pure COMPOSE field renderer. Its lines exclude the app status row: inline
 * callers subtract `lines.length` from the prose viewport; fullscreen callers
 * can append the status row to fill the terminal exactly.
 */
export function renderComposerLayout(options: ComposerLayoutOptions): ComposerLayout {
  const { composer } = options;
  const terminalHeight = Math.max(4, Math.floor(options.terminalHeight));
  const terminalWidth = Math.max(8, Math.floor(options.terminalWidth));
  const fullscreen = options.fullscreen ?? composer.fullscreen;
  const indent = fullscreen ? "" : options.indent ?? "";
  const availableWidth = Math.max(8, terminalWidth - visibleWidth(indent));
  const fieldWidth = fullscreen
    ? terminalWidth
    : Math.max(8, Math.min(Math.floor(options.measure), availableWidth));
  const cap = composerHeightCap(terminalHeight, options.composeMaxHeight);
  const lineCount = composerLineCount(composer);
  const cursor = composerPosition(composer);
  const inputWidth = Math.max(1, fieldWidth - visibleWidth("┃ ") - visibleWidth("› "));
  const wrapped = options.softWrap === true
    ? wrappedComposerLayout(composer, inputWidth)
    : null;
  const rowCount = wrapped?.rowCount ?? lineCount;
  const cursorRow = wrapped?.cursorRow ?? cursor.line;
  const footerCapacity = Math.max(
    1,
    fullscreen ? terminalHeight - 3 : terminalHeight - 4
  );
  const footer = renderComposerFooter(
    indent,
    fieldWidth,
    fullscreen,
    options.narrow === true,
    options.footerNotice ?? null,
    options.footerHints,
    options.retaking === true
  ).slice(0, footerCapacity);
  // Inline always leaves one row of story visible plus the status row.
  const bodyCapacity = fullscreen
    ? Math.max(1, terminalHeight - 2 - footer.length)
    : Math.max(1, Math.min(cap, terminalHeight - 3 - footer.length));
  const bodyRows = fullscreen ? bodyCapacity : Math.min(rowCount, bodyCapacity);
  const scrollTop = retainedScrollTop(rowCount, bodyRows, cursorRow, options.scrollTop);
  const title = options.title ?? composerTitle(fullscreen, options.directingPart);
  const counter = !fullscreen && lineCount > 1 ? `${lineCount} / ${cap} lines` : "";
  const status = options.status ?? (counter.length > 0 ? { text: counter } : undefined);
  const top = renderComposerTop(indent, fieldWidth, title, status);
  const body: FrameLine[] = [];
  for (let viewportRow = 0; viewportRow < bodyRows; viewportRow += 1) {
    const sourceIndex = scrollTop + viewportRow;
    const common = {
      composer,
      caret: options.caret ?? "focused" as ComposerCaret,
      emptyDraft: composer.text.length === 0,
      placeholder: options.placeholder ?? "direct the take…",
      indent,
      fieldWidth
    };
    const projectedRow = wrapped?.rowAt(sourceIndex);
    const sourceLine = projectedRow?.sourceIndex ?? (wrapped === null ? sourceIndex : lineCount);
    body.push(projectedRow === undefined
        ? renderBodyRow({
        ...common,
        sourceIndex: wrapped === null ? sourceIndex : lineCount,
        cursorColumn: wrapped === null && sourceIndex === cursor.line ? cursor.column : null
      })
        : renderWrappedBodyRow({
          ...common,
          row: projectedRow,
          cursorColumn: sourceIndex === cursorRow ? cursor.column : null
        }));
  }
  return {
    lines: [top, ...body, ...footer],
    lineCount,
    cap,
    bodyRows,
    scrollTop,
    cursorViewportRow: cursorRow - scrollTop,
    fieldWidth,
    fullscreen,
    dimsStory: options.focusDim === true
  };
}

interface BodyRowOptions {
  composer: ComposerState;
  sourceIndex: number;
  cursorColumn: number | null;
  caret: ComposerCaret;
  emptyDraft: boolean;
  placeholder: string;
  indent: string;
  fieldWidth: number;
}

interface WrappedBodyRowOptions extends Omit<BodyRowOptions, "sourceIndex"> {
  row: WrappedComposerRow;
}

function renderWrappedBodyRow(options: WrappedBodyRowOptions): FrameLine {
  const prompt = options.row.sourceIndex === 0 && options.row.first ? "› " : "  ";
  const prefix = [segment("┃ ", "compose accent"), segment(prompt, "compose accent")];
  const selection = composerLineSelection(options.composer, options.row.sourceIndex);
  const selectedStart = selection === null ? options.row.end : Math.max(options.row.start, selection.start);
  const selectedEnd = selection === null ? options.row.start : Math.min(options.row.end, selection.end);
  const selectedLineBreak = selection?.lineBreak === true && options.row.last;
  const inputWidth = Math.max(1, options.fieldWidth - visibleWidth("┃ ") - visibleWidth(prompt));
  const rowWidth = cellsBetween(options.composer, options.row.sourceIndex, options.row.start, options.row.end);
  const lineBreakMarker = selectedLineBreak && rowWidth < inputWidth;
  const input = selectedStart < selectedEnd || selectedLineBreak
    ? [
      ...renderComposerRange(
        options.composer,
        options.row.sourceIndex,
        options.row.start,
        options.row.end,
        "compose accent"
      ),
      ...(lineBreakMarker
        ? [renderComposerLineBreak(
          options.composer, options.row.sourceIndex, true, "compose accent"
        )]
        : [])
    ]
    : options.cursorColumn === null
      ? renderComposerRange(
        options.composer, options.row.sourceIndex, options.row.start, options.row.end
      )
      : renderWrappedInput(options, options.cursorColumn);
  return composerFieldLine(options.indent, options.fieldWidth, [...prefix, ...input]);
}

function cellsBetween(composer: ComposerState, line: number, start: number, end: number): number {
  let width = 0;
  for (let column = start; column < end; column += 1) {
    width += composerLineCell(composer, line, column)?.width ?? 0;
  }
  return width;
}

function renderWrappedInput(options: WrappedBodyRowOptions, cursorColumn: number): FrameLine {
  const cursor = Math.max(options.row.start, Math.min(options.row.end, cursorColumn));
  const cursorCell = cursor < options.row.end
    ? composerLineCell(options.composer, options.row.sourceIndex, cursor)
    : null;
  const focusedConsumes = options.caret === "focused" && cursorCell !== null;
  const caretText = options.caret === "focused"
    ? focusedConsumes ? cursorCell!.text : " "
    : options.caret === "unfocused" ? "▯" : "▏";
  const before = composerLineSlice(
    options.composer, options.row.sourceIndex, options.row.start, cursor
  );
  const after = composerLineSlice(
    options.composer,
    options.row.sourceIndex,
    cursor + (focusedConsumes ? 1 : 0),
    options.row.end
  );
  const lineStart = composerLineStart(options.composer, options.row.sourceIndex);
  const focusedBreak = options.caret === "focused"
    && cursor === composerLineLength(options.composer, options.row.sourceIndex)
    && options.row.last
    && composerLineHasBreak(options.composer, options.row.sourceIndex);
  if (options.emptyDraft && options.row.start === 0 && options.row.end === 0) {
    return [
      { text: caretText, role: "background", background: "compose accent" },
      segment(options.placeholder, "chrome")
    ];
  }
  return [
    ...(before.length > 0
      ? renderComposerRange(
        options.composer, options.row.sourceIndex, options.row.start, cursor
      )
      : []),
    options.caret === "focused"
      ? {
        text: caretText,
        role: "background",
        background: "compose accent",
        ...(focusedConsumes || focusedBreak ? { composerStart: lineStart + cursor } : {})
      }
      : segment(caretText, options.caret === "streaming" ? "chrome" : "compose accent"),
    ...(after.length > 0
      ? renderComposerRange(
        options.composer,
        options.row.sourceIndex,
        cursor + (focusedConsumes ? 1 : 0),
        options.row.end
      )
      : [])
  ];
}

function renderBodyRow(options: BodyRowOptions): FrameLine {
  const prompt = options.sourceIndex === 0 ? "› " : "  ";
  const prefix = [segment("┃ ", "compose accent"), segment(prompt, "compose accent")];
  const inputWidth = Math.max(1, options.fieldWidth - visibleWidth("┃ ") - visibleWidth(prompt));
  const input = options.cursorColumn === null
    ? renderPlainInput(options.composer, options.sourceIndex, inputWidth)
    : renderComposerInput(options.composer, options.sourceIndex, options.cursorColumn, inputWidth,
      options.caret, options.emptyDraft, options.placeholder);
  return composerFieldLine(options.indent, options.fieldWidth, [...prefix, ...input]);
}

export function renderComposerInput(
  composer: ComposerState,
  sourceIndex: number,
  cursorColumn: number,
  width: number,
  caret: ComposerCaret,
  emptyDraft: boolean,
  placeholder: string
): FrameLine {
  const length = composerLineLength(composer, sourceIndex);
  const cursor = Math.max(0, Math.min(length, cursorColumn));
  const cursorCell = composerLineCell(composer, sourceIndex, cursor);
  const selection = composerLineSelection(composer, sourceIndex);
  const cursorSelected = selection !== null && cursor >= selection.start && cursor < selection.end;
  const hasBreak = composerLineHasBreak(composer, sourceIndex);
  const focusedConsumes = caret === "focused" && cursorCell !== null;
  const focusedBreak = caret === "focused" && cursor === length && hasBreak;
  const caretText = caret === "focused"
    ? focusedConsumes ? cursorCell.text : " "
    : caret === "unfocused" ? "▯" : "▏";
  const caretWidth = Math.max(1, focusedConsumes ? cursorCell.width : visibleWidth(caretText));
  let start = cursor;
  let beforeWidth = 0;
  while (start > 0) {
    const nextStart = start - 1;
    const nextWidth = composerLineCell(composer, sourceIndex, nextStart)?.width ?? 0;
    const leading = nextStart > 0 ? 1 : 0;
    if (leading + beforeWidth + nextWidth + caretWidth > width) break;
    start = nextStart;
    beforeWidth += nextWidth;
  }

  const parts: FrameLine = [];
  let used = 0;
  if (start > 0 && width > 0) {
    parts.push(segment("…", "chrome"));
    used = 1;
  }
  const before = composerLineSlice(composer, sourceIndex, start, cursor);
  if (before.length > 0) {
    parts.push(...renderComposerRange(composer, sourceIndex, start, cursor));
    used += visibleWidth(before);
  }
  if (used < width) {
    if (caret === "focused") {
      parts.push({
        text: caretText,
        role: "background",
        background: cursorSelected ? "focus / accent" : "compose accent",
        ...(focusedConsumes || focusedBreak
          ? { composerStart: composerLineStart(composer, sourceIndex) + cursor }
          : {})
      });
    } else {
      parts.push(segment(caretText, caret === "streaming" ? "chrome" : "compose accent"));
    }
    used += caretWidth;
  }

  if (emptyDraft && length === 0) {
    const room = Math.max(0, width - used);
    if (room > 0) parts.push(...fitLine([segment(placeholder, "chrome")], room));
    return parts;
  }

  const afterStart = cursor + (focusedConsumes ? 1 : 0);
  let afterIndex = afterStart;
  const after: string[] = [];
  let afterWidth = 0;
  while (afterIndex < length) {
    const next = composerLineCell(composer, sourceIndex, afterIndex)!;
    const nextWidth = next.width;
    if (used + afterWidth + nextWidth > width) break;
    after.push(next.text);
    afterWidth += nextWidth;
    afterIndex += 1;
  }
  const clipped = afterIndex < length;
  if (clipped && width - used > 0) {
    while (after.length > 0 && used + afterWidth + 1 > width) {
      afterWidth -= visibleWidth(after.pop()!);
      afterIndex -= 1;
    }
  }
  if (after.length > 0) {
    parts.push(...renderComposerRange(composer, sourceIndex, afterStart, afterIndex));
  }
  if (clipped && used + afterWidth < width) parts.push(segment("…", "chrome"));
  else if (!focusedBreak && hasBreak && used + afterWidth < width) {
    parts.push(renderComposerLineBreak(composer, sourceIndex, selection?.lineBreak === true));
  }
  return parts;
}

function renderPlainInput(composer: ComposerState, sourceIndex: number, width: number): FrameLine {
  const length = composerLineLength(composer, sourceIndex);
  let end = 0;
  let used = 0;
  while (end < length) {
    const cell = composerLineCell(composer, sourceIndex, end)!;
    if (used + cell.width > width) break;
    used += cell.width;
    end += 1;
  }
  const clipped = end < length;
  while (clipped && end > 0 && used + 1 > width) {
    end -= 1;
    used -= composerLineCell(composer, sourceIndex, end)!.width;
  }
  const parts = [
    ...renderComposerRange(composer, sourceIndex, 0, end),
    ...(clipped && used < width ? [segment("…", "chrome")] : [])
  ];
  if (!clipped && composerLineHasBreak(composer, sourceIndex) && used < width) {
    const selection = composerLineSelection(composer, sourceIndex);
    parts.push(renderComposerLineBreak(composer, sourceIndex, selection?.lineBreak === true));
  }
  return parts;
}

function retainedScrollTop(
  lineCount: number,
  bodyRows: number,
  cursorLine: number,
  previous: number | null | undefined
): number {
  const maximum = Math.max(0, lineCount - bodyRows);
  const initial = previous !== null && previous !== undefined && Number.isFinite(previous)
    ? Math.floor(previous)
    : cursorLine - bodyRows + 1;
  let top = Math.max(0, Math.min(maximum, initial));
  if (cursorLine < top) top = cursorLine;
  else if (cursorLine >= top + bodyRows) top = cursorLine - bodyRows + 1;
  return Math.max(0, Math.min(maximum, top));
}

/**
 * Apply only to page/story rows before the composer is appended. With focus
 * dim off this changes semantic chrome accents, never prose or human spans.
 */
export function applyComposeMode(lines: readonly FrameLine[], focusDim = false): FrameLine[] {
  return lines.map((line) => line.map((part) => ({
    ...part,
    role: composeRole(part.role, focusDim),
    background: composeRole(part.background, focusDim)
  })));
}

/** Style story rows plus the full-height rail while leaving the composer and
 * status portions of the page column untouched. */
export function applyComposePageMode(
  lines: readonly FrameLine[],
  storyRows: number,
  pageWidth: number,
  focusDim = false
): FrameLine[] {
  const [page, rail] = splitFrame(lines, pageWidth);
  const styledPage = [
    ...applyComposeMode(page.slice(0, storyRows), focusDim),
    ...page.slice(storyRows)
  ];
  const styledRail = applyComposeMode(rail, focusDim);
  return styledPage.map((line, index) => [...line, ...(styledRail[index] ?? [])]);
}

/** The context gauge tells its fill apart by colour alone, so collapsing every
 *  rail role would leave one uniform bar reading as a full window. Focus dim
 *  mutes those cells to chrome instead: nothing stays lit against the
 *  composer, and the meter keeps the boundary it exists to draw. */
const GAUGE_ROLES: ReadonlySet<DisplayRole> = new Set([
  "context voice", "context facts", "context recent", "context summary", "context note",
  "context growth", "context growth pulse"
]);

function composeRole(role: DisplayRole | undefined, focusDim: boolean): DisplayRole | undefined {
  if (role === undefined || role === "background" || role === "raised") return role;
  if (focusDim) return GAUGE_ROLES.has(role) ? "chrome" : "dimmed page";
  return role === "focus / accent" || role === "accent · deep" ? "compose accent" : role;
}
