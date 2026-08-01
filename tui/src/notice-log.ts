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
}

export function createNoticeLog(): NoticeLog {
  return {
    entries: [],
    nextId: 1,
    seen: { toast: null, banner: null, check: null },
    cursor: 0
  };
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
    if (text === null || text.trim().length === 0) continue;
    // Newest first, and the cursor stays on the notice the writer came from.
    log.entries.unshift({ id: log.nextId, at: sources.now, channel, text });
    log.nextId += 1;
    log.cursor = 0;
  }
}

/** The three feedback channels the app can be speaking through, read off the
 *  state that already holds them. Called from the dispatcher and from repaint,
 *  so a notice raised by a backend task lands here too. */
export function recordSessionNotices(state: {
  toast: string | null;
  connection: { down: boolean; attempt: number };
  settings: { result: { message: string } | null } | null;
  notices: NoticeLog;
  now: number;
}): void {
  recordNotices(state.notices, {
    toast: state.toast,
    banner: state.connection.down
      ? `▲ connection lost · attempt ${state.connection.attempt}/5 ·`
        + " everything is saved on disk · R retries now"
      : null,
    check: state.settings?.result?.message ?? null,
    now: state.now
  });
}

export function clearNoticeLog(log: NoticeLog): void {
  log.entries = [];
  log.cursor = 0;
}

export function boundedNoticeCursor(log: NoticeLog, value: number): number {
  return Math.max(0, Math.min(Math.max(0, log.entries.length - 1), value));
}
