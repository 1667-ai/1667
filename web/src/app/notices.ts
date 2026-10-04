import type { Notice, AppState } from "./state.js";
import type { Store } from "./store.js";

/** The log keeps the newest notices only; a tab that runs for days must not grow it without end. */
const MAX_NOTICES = 500;
let nextNoticeId = 0;

/** Writes one message to the notice log. A `key` makes it idempotent: a later
 * call with the same key records nothing. */
export function recordNotice(
  store: Store<AppState>,
  channel: Notice["channel"],
  text: string,
  key?: string
): void {
  store.set((state) => {
    if (key !== undefined && state.notices.some((notice) => notice.key === key)) return state;
    const notice: Notice = { id: (nextNoticeId += 1), at: Date.now(), channel, text, ...(key === undefined ? {} : { key }) };
    return { ...state, notices: [...state.notices, notice].slice(-MAX_NOTICES) };
  });
}
