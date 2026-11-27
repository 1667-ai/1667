import type { UpdateNoticeService } from "../../host/web-server.js";
import { NO_UPDATE_NOTICE, type UpdateNoticeStatus } from "../../shared/update-notice.js";
import { loadConfig } from "../../tui/src/config.js";
import {
  createBackgroundUpdateStarter,
  type BackgroundUpdateStarter
} from "../../tui/src/index.js";

/**
 * The background update check for `1667 web`, published through
 * `/api/status` for the page to show as a toast (`docs/web.md`). The TUI runs
 * the same check from `tui/src/launch.ts`; this holds its result for a
 * surface that cannot be handed a callback, because the browser asks for it
 * over HTTP instead.
 *
 * The check itself is the TUI's, unchanged: same registry request, same
 * cache key, so the two surfaces share one 24-hour cache and a run of
 * `1667 web` is not distinguishable from a run of the TUI. This module adds
 * no interface marker of any kind, which is what keeps 1667's claim that it
 * ships no telemetry true — a check that named the web UI would be a
 * web-usage counter.
 *
 * Notify only. Nothing here installs anything, and the message is produced
 * by the check, not by this module: an `1667 upgrade` command appears in it
 * only where the check already proved a Managed Installation.
 */
export interface WebUpdateNotice extends UpdateNoticeService {
  /**
   * Starts the one check for this run and returns its stop hook. Call it
   * after the server is up: the check needs no server, but a notice nothing
   * can read yet is wasted, and the TUI starts its own check at the same
   * point in its own startup.
   */
  start(): () => void;
}

export interface WebUpdateNoticeOptions {
  /**
   * The checker to start, `null` when this run has none — the preference is
   * `off`, or this platform has no published release target. The default
   * reads `~/.config/1667/config.json`, the same file the TUI writes, so
   * `updates.mode`, `updates.channel`, `updates.skippedVersion` and
   * `AI_1667_NO_UPDATE_CHECK` all hold for the web UI with no second
   * setting and no second config surface. A test supplies its own so it
   * never waits on a real timer or reaches a real registry.
   */
  readonly createStarter?: () => BackgroundUpdateStarter | null;
}

export function createWebUpdateNotice(
  options: WebUpdateNoticeOptions = {}
): WebUpdateNotice {
  const createStarter = options.createStarter
    ?? (() => createBackgroundUpdateStarter(loadConfig()));
  // The only mutable state: the check settles long after `/api/status`
  // started answering, so every read goes through `read()` rather than a
  // value the server captured at startup.
  let status: UpdateNoticeStatus = NO_UPDATE_NOTICE;
  return {
    read: () => status,
    start: () => {
      let starter: BackgroundUpdateStarter | null;
      try {
        starter = createStarter();
      } catch {
        // Update checking is advisory, as it is in `tui/src/launch.ts`: a
        // config or platform failure must never stop `1667 web` serving.
        return () => undefined;
      }
      if (starter === null) return () => undefined;
      let stop: (() => void) | null = null;
      // `pending` before the first notice can arrive, never after: this is
      // the page's one signal that a later read can differ, so it must be
      // true for exactly as long as a check is actually running.
      status = { pending: true, notice: null };
      try {
        stop = starter((message) => { status = { pending: false, notice: message }; });
      } catch {
        status = NO_UPDATE_NOTICE;
        return () => undefined;
      }
      return () => {
        try {
          stop?.();
        } catch {
          // Shutdown is advisory too. A broken stop hook must not keep
          // `1667 web` from releasing the project lock.
        }
        // Nothing is checking any more, so stop telling a page to ask again.
        // A notice that already arrived stays readable.
        if (status.notice === null) status = NO_UPDATE_NOTICE;
      };
    }
  };
}
