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
    || !toastLineAvailable(state)
    || confirmationActive(state)) return;
  state.pendingUpdateNotice = null;
  state.toast = message;
  // publishBackgroundUpdateNotice already wrote the full message to the log.
  markNoticeSeen(state.notices, "toast", message);
}

/** Match the full-screen branches in renderStoryScreen. These surfaces do not
 * draw state.toast, so they must not consume a one-shot update result. */
function toastLineAvailable(state: RuntimeState): boolean {
  if (state.mode === "LOG") return false;
  if (state.mode === "SEARCH" && state.search !== null) return false;
  if (state.mode === "RECORD" && state.record !== null) return false;
  if (state.mode === "REQUEST" && state.request !== null) return false;
  if (state.mode === "PROBS" && state.probs !== null) return false;
  if (state.mode === "ASIDE" && state.aside !== null && state.aside.busy) {
    return false;
  }
  return true;
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
