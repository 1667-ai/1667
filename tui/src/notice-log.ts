import type { KeyEvent } from "@opentui/core";
import { connectionNoticeText } from "./screens/connection-banner.js";
import type { ResolvedKey } from "./keys.js";

/** C-37 · log — the session's notices, so nothing the app said is
 *  unrecoverable.
 *
 *  Decision 24 caps the other three feedback channels at three or four wrapped
 *  rows. The caps are only honest because everything written to those channels
 *  is also written here, truncated or not. */
export type NoticeChannel = "toast" | "banner" | "check";

export interface SessionNotice {
  readonly id: number;
  /** Client wall-clock time the message first appeared. */
  readonly at: number;
  readonly channel: NoticeChannel;
  readonly text: string;
}

export interface NoticeLog {
  entries: SessionNotice[];
  nextId: number;
  /** Last text seen on each channel, so one message is recorded once however
   *  many frames it survives. */
  seen: Record<NoticeChannel, string | null>;
  /** Row the log surface opens on: the notice you came from. */
  cursor: number;
  /** Rows scrolled into the focused notice, beyond wherever it opens by
   *  default. Only meaningful for a notice taller than the surface — see
   *  `setNoticeCursor`, which is the only place this resets. */
  scrollOffset: number;
  /** Where `esc` returns to. The log is reachable from the map as well as the
   *  page, and closing it must not drop the writer out of the map. */
  returnMode: "NAV" | "MAP";
}

export function createNoticeLog(): NoticeLog {
  return {
    entries: [],
    nextId: 1,
    seen: { toast: null, banner: null, check: null },
    cursor: 0,
    scrollOffset: 0,
    returnMode: "NAV"
  };
}

/** Move the cursor to a bounded notice and reset the scroll offset: a
 *  freshly focused notice always opens at its own head, per C-27. Every site
 *  that writes `cursor` goes through this, so none can forget the reset. */
export function setNoticeCursor(log: NoticeLog, value: number): void {
  log.cursor = boundedNoticeCursor(log, value);
  log.scrollOffset = 0;
}

/** What the app is saying right now, per channel. */
export interface NoticeSources {
  readonly toast: string | null;
  readonly banner: string | null;
  readonly check: string | null;
  readonly now: number;
}

/** Write anything new to the log. Idempotent: calling it twice for the same
 *  frame records nothing the second time, which is what lets both the
 *  dispatcher and the repaint call it without agreeing on who owns the seam. */
export function recordNotices(log: NoticeLog, sources: NoticeSources): void {
  for (const channel of ["toast", "banner", "check"] as const) {
    const text = sources[channel];
    if (text === log.seen[channel]) continue;
    log.seen[channel] = text;
    // A cleared channel is recorded as cleared, so raising the same message
    // again is a second event rather than a repeat this pass never sees: the
    // dispatcher nulls a toast before the reducer can set the same one back.
    if (text === null || text.trim().length === 0) continue;
    // Newest first, and the cursor stays on the notice the writer came from.
    log.entries.unshift({ id: log.nextId, at: sources.now, channel, text });
    log.nextId += 1;
    setNoticeCursor(log, 0);
  }
}

/** Write one notice the channels cannot carry.
 *
 * A toast is capped at four wrapped rows, and an import fidelity report is not.
 * C-37 is what makes that cap honest, so the whole report is written here while
 * the toast keeps the headline. This is a discrete event rather than a channel
 * state, so it bypasses the repeat guard: importing the same file twice is two
 * events. */
export function recordNotice(
  log: NoticeLog,
  channel: NoticeChannel,
  text: string,
  now = Date.now()
): void {
  if (text.trim().length === 0) return;
  log.entries.unshift({ id: log.nextId, at: now, channel, text });
  log.nextId += 1;
  setNoticeCursor(log, 0);
}

/** The three feedback channels the app can be speaking through, read off the
 *  state that already holds them. Called from the dispatcher and from repaint,
 *  so a notice raised by a backend task lands here too. */
export function recordSessionNotices(state: {
  toast: string | null;
  connection: Parameters<typeof connectionNoticeText>[0];
  settings: {
    result: { message: string } | null;
    sampling: { result: string | null } | null;
  } | null;
  notices: NoticeLog;
}, now = Date.now()): void {
  recordNotices(state.notices, {
    toast: state.toast,
    banner: connectionNoticeText(state.connection),
    // Settings speaks through two result slots: the panel's own check, and
    // the nested sampling editor's. Both are shown to the writer, so both are
    // recorded — a message that vanishes when its panel closes is exactly
    // what C-37 exists to stop.
    check: state.settings?.result?.message
      ?? state.settings?.sampling?.result
      ?? null,
    now
  });
}

export function clearNoticeLog(log: NoticeLog): void {
  log.entries = [];
  setNoticeCursor(log, 0);
}

/** Mark a channel's current text as already recorded, with no entry written
 *  for it. For a caller that just wrote the full account directly through
 *  `recordNotice`, so the channel's own short text is not worth a second,
 *  redundant entry: without this, the next `recordNotices` pass (from the
 *  following `repaint`) would see that text as new and record it anyway,
 *  unshifting it above the entry that already carries the whole story and
 *  moving focus onto it. */
export function markNoticeSeen(log: NoticeLog, channel: NoticeChannel, text: string): void {
  log.seen[channel] = text;
}

/** C-37's keys, in one place the way the request viewer keeps its own: `↑↓`
 *  move · `⇧↑↓` scrolls a line and `pgup`/`pgdn` a page within the focused
 *  notice, the same vocabulary and action names `reference-bindings.ts` uses
 *  for NAV · `↵` copies · `x` clears · `!` or `esc` closes. `!` toggles, so
 *  the surface closes from wherever the writer opened it. */
export function resolveLogKey(key: KeyEvent): ResolvedKey {
  if (key.name === "down") return { action: key.shift ? "scroll-line-down" : "focus-next" };
  if (key.name === "up") return { action: key.shift ? "scroll-line-up" : "focus-previous" };
  if (key.name === "pagedown") return { action: "scroll-down" };
  if (key.name === "pageup") return { action: "scroll-up" };
  if (key.name === "return") return { action: "copy-part" };
  if (key.name === "x") return { action: "clear-log" };
  if (key.sequence === "!") return { action: "cancel" };
  return { action: "none" };
}

export function boundedNoticeCursor(log: NoticeLog, value: number): number {
  return Math.max(0, Math.min(Math.max(0, log.entries.length - 1), value));
}
