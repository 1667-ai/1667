import {
  markNoticeSeen,
  recordNotice,
  recordSessionNotices
} from "./notice-log.js";
import type { RuntimeState } from "./state.js";
import {
  resolveStoryScreenRoute,
  routeShowsToast
} from "./screens/story-route.js";

/** Record an update result now, then show it when no existing message or
 * confirmation owns the toast line. */
export function publishBackgroundUpdateNotice(
  state: RuntimeState,
  message: string,
  repaint: () => void
): void {
  recordSessionNotices(state);
  recordNotice(state.notices, "toast", message);
  state.pendingUpdateNotice = message;
  promotePendingUpdateNotice(state);
  repaint();
}

/** Move a recorded update result to the toast line when it is safe to do so. */
export function promotePendingUpdateNotice(state: RuntimeState): void {
  const message = state.pendingUpdateNotice;
  if (message === null
    || state.toast !== null
    || !routeShowsToast(resolveStoryScreenRoute(state))) return;
  state.pendingUpdateNotice = null;
  state.toast = message;
  // publishBackgroundUpdateNotice already wrote the full message to the log.
  markNoticeSeen(state.notices, "toast", message);
}
