import type { HitRow, HitRows } from "../hit.js";
import { boundedNoticeCursor, type NoticeLog, type SessionNotice } from "../notice-log.js";
import type { StoryScreenState } from "../state.js";
import { tagGlyph, tagRole } from "../tag-presentation.js";
import { wrapFeedback } from "./feedback-wrap.js";
import { addInlineHits } from "./story/hits.js";
import { renderSurfaceBreadcrumb } from "./surface-breadcrumb.js";
import {
  fitLine,
  lineWidth,
  segment,
  truncate,
  type FrameComposition,
  type FrameLine
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
    return [[...head, segment(truncate(oneLine(notice.text), measure), "prose · dim")]];
  }
  // The log is the surface with no cap, so the expanded notice wraps as far as
  // it needs to and keeps its recovery keys on the last row.
  const wrapped = wrapFeedback(notice.text, measure, null);
  return wrapped.rows.map((row, index): FrameLine => index === 0
    ? [...head, segment(row, "prose")]
    : [segment(" ".repeat(BODY_COLUMN)), segment(row, "prose")]);
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

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Wall-clock, because a notice's usefulness is "when did this happen". */
function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
