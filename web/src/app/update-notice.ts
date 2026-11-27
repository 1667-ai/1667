import {
  normalizeUpdateNoticeStatus,
  type UpdateNoticeStatus
} from "../../../shared/update-notice.js";
import type { UpdateNoticeApi } from "../../../client/update-notice-api.js";
import type { AppState } from "./state.js";
import type { Store } from "./store.js";
import { pushToast } from "./toasts.js";

/**
 * Shows the background update check's notice as a toast (`docs/web.md`).
 * `host/web-server.ts` is the only source: this reads `/api/status` and
 * renders what it says, and nothing in the browser decides whether an update
 * exists or what to call it.
 *
 * One read is not enough. The check starts about a second after `1667 web`
 * does and can take longer, while a `1667 web` session runs for hours, so a
 * page that asked once at connect time would almost never see the answer.
 * This asks again while — and only while — the server says the check is
 * still running: `pending` false means the answer is settled (or there is no
 * check at all, with the preference `off`), and this stops at once. A run
 * with an answer already in the shared 24-hour cache is usually settled by
 * the first read, so the common case costs no request beyond the one
 * `client/web-bridge-connect.ts` already makes.
 */

/** Long enough that a check waiting on a slow registry has moved on between
 * reads, short enough that a notice does not sit unseen. */
const RETRY_INTERVAL_MS = 5_000;

/** The whole budget: six reads of a loopback route, 30 seconds after
 * connect, and then silence for the rest of the session. A check still
 * running past that is retrying a failed registry request with its own
 * backoff, which this must not chase — nothing is lost but a notice the
 * next run will show. */
const MAX_ATTEMPTS = 6;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface UpdateNoticeWatchOptions {
  readonly store: Store<AppState>;
  readonly api: UpdateNoticeApi;
  /**
   * What the connect-time `/api/status` read already said, so a settled
   * answer needs no further request. `undefined` (a server or a test status
   * that carries no `update` field) reads as "ask once". The value reaches
   * here from `client/web-bridge-connect.ts`, which casts the status body
   * rather than reading it field by field, so it is normalized below like
   * any other answer off the wire.
   */
  readonly initial?: unknown;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (timer: TimerHandle) => void;
}

/**
 * Starts the watch and returns its stop hook. Disposing drops the pending
 * read and its timer, so `<StrictMode>`'s double-invoked effect and a
 * Reconnect never leave an earlier watch running — the same contract
 * `app/connection.ts`'s own disposer has.
 */
export function watchUpdateNotice(options: UpdateNoticeWatchOptions): () => void {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let timer: TimerHandle | null = null;
  let disposed = false;
  let attemptsLeft = MAX_ATTEMPTS;

  const consider = (status: UpdateNoticeStatus): void => {
    if (disposed) return;
    if (status.notice !== null) {
      // Keyed, so a Reconnect that starts a second watch does not show the
      // same notice twice, and so the notice log keeps one entry for it the
      // way it keeps one for each recovery warning.
      pushToast(options.store, status.notice, updateNoticeKey(status.notice));
      return;
    }
    if (!status.pending || attemptsLeft <= 0) return;
    attemptsLeft -= 1;
    timer = schedule(() => {
      timer = null;
      void read();
    }, RETRY_INTERVAL_MS);
  };

  const read = async (): Promise<void> => {
    if (disposed) return;
    let status: UpdateNoticeStatus;
    try {
      status = await options.api.load();
    } catch {
      // A failed update check never reaches the reader, here as in the TUI.
      // The connection screens already report a server that went away.
      return;
    }
    consider(status);
  };

  // `undefined` means this page has no answer yet, which is a reason to ask,
  // not a reason to assume there is nothing to wait for.
  consider(options.initial === undefined
    ? { pending: true, notice: null }
    : normalizeUpdateNoticeStatus(options.initial));

  return () => {
    disposed = true;
    if (timer !== null) cancel(timer);
    timer = null;
  };
}

/** The notice log key for one update notice. The message names the version,
 * so one key per version: a later run that finds a newer one still shows it. */
export function updateNoticeKey(notice: string): string {
  return `update:${notice}`;
}
