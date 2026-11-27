/**
 * The background update check's one result, as `/api/status` carries it to
 * the web UI. `host/web-server.ts` reads it from a service
 * `cli/src/web-command.ts` wires, and `client/update-notice-api.ts` reads it
 * back in the browser.
 *
 * The check resolves about a second after `1667 web` starts, and later than
 * that when the registry is slow, so one read at connect time usually sees
 * nothing yet. `pending` is what tells the page a later read can differ: it
 * is true only while a check runs and has produced no notice. A run with the
 * check turned off reports `{ pending: false, notice: null }`, so the page
 * asks once and stops.
 *
 * `notice` is the message the TUI shows, word for word — `updateNotice` in
 * `tui/src/background-update-check.ts` makes it. The web path never rewords
 * it and never decides for itself whether to name an upgrade command.
 */
export interface UpdateNoticeStatus {
  readonly pending: boolean;
  readonly notice: string | null;
}

export const NO_UPDATE_NOTICE: UpdateNoticeStatus = { pending: false, notice: null };

/** Reads one `/api/status` `update` field. Anything unexpected reads as no
 * notice: an advisory message is never worth a failed page load. A notice
 * settles the answer, so it never also asks the page to read again. */
export function normalizeUpdateNoticeStatus(value: unknown): UpdateNoticeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return NO_UPDATE_NOTICE;
  const record = value as Record<string, unknown>;
  const notice = typeof record.notice === "string" && record.notice.length > 0
    ? record.notice
    : null;
  return { pending: record.pending === true && notice === null, notice };
}
