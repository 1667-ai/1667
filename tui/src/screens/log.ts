import type { HitRow, HitRows } from "../hit.js";
import { boundedNoticeCursor, type NoticeLog, type SessionNotice } from "../notice-log.js";
import {
  noticeMarkupBlocks,
  parseNoticeMarkup,
  type NoticeMarkupStyle
} from "../notice-markup.js";
import type { StoryScreenState } from "../state.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";
import { wrapText, type WrappedLine } from "../wrap.js";
import { addInlineHits } from "./story/hits.js";
import { renderSurfaceBreadcrumb } from "./surface-breadcrumb.js";
import {
  fitLine,
  lineWidth,
  segment,
  truncate,
  type FrameComposition,
  type FrameLine,
  type FrameSegment
} from "./story/frame.js";

/** Title rule, blank, closing rule, breadcrumb. */
const SHELL_ROWS = 4;
const STAMP_WIDTH = 10;
/** Cells the expanded notice indents its wrapped rows by. */
const BODY_COLUMN = 2 + STAMP_WIDTH;

/** Rows the log body has to paint notices in, at a given terminal height.
 *  Shared with `overlay-actions.ts` so a page-scroll step matches exactly
 *  what one page of this screen shows. */
export function logBodyHeight(height: number): number {
  return Math.max(1, height - SHELL_ROWS);
}

/** The largest `scrollOffset` that still moves the view within the focused
 *  notice, at a given terminal size. Shared with `overlay-actions.ts` so an
 *  action's clamp and `windowStart`'s render can never disagree: both are
 *  built from the same `noticeRows`/`logBodyHeight` measurement. Zero for a
 *  notice that fits beside its neighbours — there is nowhere to scroll it. */
export function maxNoticeScrollOffset(log: NoticeLog, width: number, height: number): number {
  const cursor = boundedNoticeCursor(log, log.cursor);
  const notice = log.entries[cursor];
  if (notice === undefined) return 0;
  const rows = noticeRows(notice, true, width).length;
  const bodyHeight = logBodyHeight(height);
  return rows > bodyHeight ? rows - bodyHeight : 0;
}

/** C-37 · log: a C-02 surface holding the session's notices, newest first, the
 *  one you came from expanded. The only surface with no cap — it is what makes
 *  the caps on the other three feedback channels honest. */
export function renderLogScreen(
  state: StoryScreenState,
  log: NoticeLog,
  width: number,
  height: number,
  hitRows: HitRows
): FrameComposition {
  const cursor = boundedNoticeCursor(log, log.cursor);
  const bodyHeight = logBodyHeight(height);
  const body: FrameLine[] = [];
  const hits: Array<HitRow | null> = [];
  for (const [index, notice] of log.entries.entries()) {
    const rows = noticeRows(notice, index === cursor, width);
    for (const [offset, row] of rows.entries()) {
      body.push(row);
      hits.push(offset === 0
        ? { target: { kind: "list", index }, left: 0, right: width }
        : null);
    }
  }
  if (log.entries.length === 0) {
    // C-27: an empty state names the key that fixes it, and here the fix is
    // that there is nothing to fix.
    body.push([segment("  nothing has gone wrong yet · esc returns to the page", "prose · dim")]);
    hits.push(null);
  }
  const start = windowStart(log, cursor, bodyHeight, width);
  const shown = body.slice(start, start + bodyHeight);
  const lines = [
    renderTitle(log, width),
    [],
    ...shown,
    ...Array.from({ length: Math.max(0, bodyHeight - shown.length) }, (): FrameLine => []),
    [segment("─".repeat(Math.max(0, width)), "dimmed page")],
    renderBreadcrumb(state, log, cursor, width)
  ].slice(0, height).map((line) => fitLine(line, width));

  hitRows.length = height;
  hitRows.fill(null);
  for (let row = 0; row < Math.min(shown.length, bodyHeight); row += 1) {
    hitRows[row + 2] = hits[start + row] ?? null;
  }
  addInlineHits([lines[lines.length - 1]!], hitRows, () => true, lines.length - 1);
  return { lines, selectable: null };
}

/** The focused notice expands; the rest keep one row each. */
function noticeRows(notice: SessionNotice, focused: boolean, width: number): FrameLine[] {
  const lead = focused ? "▸ " : "  ";
  const measure = Math.max(8, width - BODY_COLUMN - 2);
  const head: FrameLine = [
    segment(lead, focused ? "focus / accent" : "chrome"),
    segment(stamp(notice.at).padEnd(STAMP_WIDTH), "chrome")
  ];
  if (!focused) {
    return [[...head, segment(truncate(oneLine(notice), measure), "prose · dim")]];
  }
  // The log is the one uncapped surface (C-37): the focused notice keeps its
  // line structure instead of collapsing to one flowing line the way the
  // capped toast/banner/check channels do (Decision 24's `wrapFeedback`,
  // deliberately untouched by this). Only a `markdown` notice — release
  // notes, today the one caller — also gets its `**bold**`/`` `code` ``/list
  // markers interpreted. A `plain` notice, which is most of them and carries
  // arbitrary user- or backend-supplied text, renders exactly as written:
  // interpreting markup there would let a story renamed to `**draft**` come
  // back from the log quietly rewritten to bold.
  return notice.kind === "markdown"
    ? markdownNoticeRows(notice.text, measure, head)
    : plainNoticeRows(notice.text, measure, head);
}

function markdownNoticeRows(text: string, measure: number, head: FrameLine): FrameLine[] {
  const { text: cleaned, runs } = parseNoticeMarkup(text);
  const wrapped = wrapText(cleaned, runs, measure);
  const blocks = noticeMarkupBlocks(cleaned);
  let blockIndex = 0;
  return wrapped.map((row, index): FrameLine => {
    while (blockIndex + 1 < blocks.length && row.start >= blocks[blockIndex + 1]!.start) {
      blockIndex += 1;
    }
    const block = blocks[blockIndex]!;
    // A list item's own `- ` already sits in `row.text` on its first row; a
    // continuation row wrapped past it, so it gets the hanging indent back
    // instead, letting the item read as one block rather than losing its
    // margin under the bullet above it.
    const hanging = block.list && row.start > block.start;
    const content = noticeRowSegments(row);
    const rowSegments = hanging ? [segment("  "), ...content] : content;
    return index === 0
      ? [...head, ...rowSegments]
      : [segment(" ".repeat(BODY_COLUMN)), ...rowSegments];
  });
}

/** A plain notice's text, wrapped with no markup interpretation at all —
 *  `wrapText` still wraps it one paragraph per source `\n` (so a multi-line
 *  notice, an import fidelity report say, keeps its own line breaks), but
 *  every character renders exactly as the app wrote it. No style runs, no
 *  list detection, no hanging indent: those are markdown-notice concerns. */
function plainNoticeRows(text: string, measure: number, head: FrameLine): FrameLine[] {
  const wrapped = wrapText(text, [], measure);
  return wrapped.map((row, index): FrameLine => {
    const content: FrameSegment[] = row.text.length === 0 ? [] : [segment(row.text, "prose")];
    return index === 0
      ? [...head, ...content]
      : [segment(" ".repeat(BODY_COLUMN)), ...content];
  });
}

/** One wrapped row's text, split at its style runs into plain, bold and code
 *  segments. `**bold**` keeps the `prose` role and adds the bold attribute —
 *  emphasis, not a different kind of text. `` `code` `` takes `chrome`, the
 *  role a technical value already carries elsewhere (the model name and
 *  route in request-viewer.ts), rather than inventing a new look for it. */
function noticeRowSegments(row: WrappedLine<NoticeMarkupStyle>): FrameSegment[] {
  if (row.text.length === 0) return [];
  const segments: FrameSegment[] = [];
  let cursor = 0;
  for (const run of row.styleRuns) {
    if (run.start > cursor) segments.push(segment(row.text.slice(cursor, run.start), "prose"));
    if (run.end > run.start) {
      segments.push(run.style === "bold"
        ? { text: row.text.slice(run.start, run.end), role: "prose", bold: true }
        : segment(row.text.slice(run.start, run.end), "chrome"));
    }
    cursor = Math.max(cursor, run.end);
  }
  if (cursor < row.text.length) segments.push(segment(row.text.slice(cursor), "prose"));
  return segments;
}

/** Keep the focused notice on screen without moving it further than it has to.
 *
 *  A notice taller than the surface starts at its own first row by default:
 *  this is the channel with no cap, so losing the explanation to a viewport
 *  that opened on the tail would defeat the point of it. `log.scrollOffset`
 *  then moves within that notice, clamped here to its own last row — the
 *  only place with the `width` a notice's actual row count depends on. A
 *  notice that fits beside its neighbours ignores the offset entirely, which
 *  is what keeps it at zero: nothing in this branch ever reads it. */
function windowStart(log: NoticeLog, cursor: number, bodyHeight: number, width: number): number {
  let row = 0;
  for (const [index, notice] of log.entries.entries()) {
    const rows = noticeRows(notice, index === cursor, width).length;
    if (index === cursor) {
      if (rows >= bodyHeight) {
        const maxOffset = rows - bodyHeight;
        return row + Math.max(0, Math.min(maxOffset, log.scrollOffset));
      }
      const end = row + rows;
      return end <= bodyHeight ? 0 : Math.max(0, end - bodyHeight);
    }
    row += rows;
  }
  return 0;
}

function renderTitle(log: NoticeLog, width: number): FrameLine {
  const count = log.entries.length;
  const stats = count === 1 ? "1 notice" : `${count} notices`;
  const line: FrameLine = [
    segment("━━ ", "brass dim"),
    segment("log", "focus / accent"),
    segment(" ━ ", "brass dim"),
    segment(`${stats} this session`, "chrome")
  ];
  const remaining = width - lineWidth(line);
  if (remaining > 0) line.push(segment(` ${"━".repeat(Math.max(0, remaining - 1))}`, "brass dim"));
  return fitLine(line, width);
}

function renderBreadcrumb(
  state: StoryScreenState,
  log: NoticeLog,
  cursor: number,
  width: number
): FrameLine {
  const leafId = state.payload.path.at(-1)?.id ?? null;
  const tag = state.payload.tags.find((item) => item.nodeId === leafId) ?? null;
  // A narrow terminal drops `x clears` first: `! or esc closes` is the
  // recovery key and must survive truncation, the way request-viewer.ts
  // drops `g/G ends` at the same width rather than risk its own tail.
  const narrow = width < 100;
  // C-37: the breadcrumb's right slot holds a scope label, never a key — the
  // keys are in the keyline beside it, per C-06. C-27: a notice taller than
  // the surface scrolls, so the surface says so.
  const keys: FrameLine = [
    segment("↑", "chrome", { kind: "action", action: "focus-previous" }),
    segment("↓", "chrome", { kind: "action", action: "focus-next" }),
    segment(" move", "chrome"),
    segment(" · ", "chrome"),
    segment("⇧↑↓ scroll", "chrome"),
    segment(" · ", "chrome"),
    segment("↵ copies", "chrome", { kind: "action", action: "copy-part" }),
    ...(narrow ? [] : [
      segment(" · ", "chrome"),
      segment("x clears", "chrome", { kind: "action", action: "clear-log" })
    ]),
    segment(" · ", "chrome"),
    segment("! or esc closes", "focus / accent", { kind: "action", action: "cancel" })
  ];
  return renderSurfaceBreadcrumb({
    mode: "LOG",
    scope: "session",
    title: state.payload.title,
    identity: tag === null ? "" : `${tagGlyph(tag.status)} ${tag.name}`,
    identityRole: tagRole(tag),
    crumb: log.entries.length === 0
      ? "nothing yet"
      : `${cursor + 1}/${log.entries.length}`,
    keys,
    width
  });
}

/** The unfocused preview row: one flowing line, same as `wrapFeedback`'s own
 *  collapse. A `markdown` notice's markers are stripped first, the same as
 *  the focused row's own parse, so a preview never shows a raw `**` or a
 *  backtick. A `plain` notice skips that parse entirely — its `**`/backtick
 *  characters, if it has any, are the writer's own text, not a marker. */
function oneLine(notice: SessionNotice): string {
  const text = notice.kind === "markdown" ? parseNoticeMarkup(notice.text).text : notice.text;
  return text.replace(/\s+/gu, " ").trim();
}

/** Wall-clock, because a notice's usefulness is "when did this happen". */
function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
