import { apiErrorCode } from "../../../client/api-error.js";

/** Backoff between attempts. Four tries span about 0.85 s. */
const BUSY_RETRY_DELAYS_MS = [100, 250, 500] as const;

/**
 * Runs a story change again while the backend answers `resource_busy`.
 *
 * The backend refuses a change at admission, before any work, when another
 * claim holds that story: for example the opportunistic residue sweep that
 * `loadStory` runs, or a list refresh reaping a deleted story. The web UI
 * overlaps reads and changes far more than the TUI does, so such a refusal is
 * a normal, short-lived event here. Retrying is safe because a refused change
 * did nothing. Any other error, or a busy answer after the last attempt, is
 * thrown as usual.
 */
export async function retryWhenBusy<T>(change: () => Promise<T>): Promise<T> {
  for (const delay of BUSY_RETRY_DELAYS_MS) {
    try {
      return await change();
    } catch (error) {
      if (apiErrorCode(error) !== "resource_busy") throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return await change();
}
