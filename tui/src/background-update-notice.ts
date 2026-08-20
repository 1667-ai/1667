import {
  markNoticeSeen,
  recordNotice,
  recordSessionNotices
} from "./notice-log.js";
import type { RuntimeState } from "./state.js";
import { activeTextComposer } from "./text-actions.js";

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
    || confirmationActive(state)) return;
  state.pendingUpdateNotice = null;
  state.toast = message;
  // publishBackgroundUpdateNotice already wrote the full message to the log.
  markNoticeSeen(state.notices, "toast", message);
}

function confirmationActive(state: RuntimeState): boolean {
  const composer = activeTextComposer(state);
  return state.quitArmed
    || state.prune !== null
    || state.chapterDeleteArmedId !== null
    || state.facts !== null && state.facts.deleteArmedId !== null
    || state.chapters !== null && state.chapters.deleteArmedId !== null
    || state.settings !== null && state.settings.deleteArmedProfileId !== null
    || state.settings?.conflict?.armed === true
    || state.editor?.conflict?.armed === true
    || state.aside?.confirmClear === true
    || state.library?.prompt?.kind === "delete"
    || composer !== null && composer.cutConfirmation !== null;
}
