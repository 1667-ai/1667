import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import type { GenerationTarget } from "../../../shared/stopped-generation.js";
import { stoppedGenerationSaveBody } from "../../../shared/stopped-generation.js";
import type { CreateNodeRequest, StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";

/**
 * Commits a stopped (or timed-out) generation's buffered text — the one
 * place that turns a `GenerationRunningState`'s authoritative buffer into a
 * `createNode` call, shared by Stop and by a timeout-class failure so both
 * go through the exact same idempotent-by-`genId` path the TUI's own
 * `settleStoppedGeneration` uses. Never called for a plain (non-timeout)
 * failure — that path discards the buffer instead, matching the TUI.
 */
export interface StopSaveRequest {
  readonly storyId: string;
  readonly genId: string;
  readonly target: GenerationTarget;
  readonly instruction: string;
  /** The authoritative buffer, verbatim — including the withheld tail. Never
   *  the presented (throttled) text. */
  readonly text: string;
}

export type StopSaveOutcome =
  /** The buffer was whitespace-only (or empty): nothing was created. The
   *  story is reloaded anyway, matching the TUI's own "empty stop reloads,
   *  saves nothing" behavior. */
  | { readonly kind: "not-substantive"; readonly payload: StoryPayload }
  | { readonly kind: "saved"; readonly payload: StoryPayload }
  /** `payload` is the best-effort reload taken after the failed commit —
   *  `null` only if that reload also failed (e.g. the connection is gone).
   *  The caller keeps the buffered text visible (`GenerationUnsavedState`)
   *  either way; nothing here ever discards it. */
  | { readonly kind: "failed"; readonly payload: StoryPayload | null; readonly error: unknown };

export async function saveStopped(
  api: StoryApi,
  request: StopSaveRequest
): Promise<StopSaveOutcome> {
  const body = stoppedGenerationSaveBody(request.target, request.genId, request.instruction, request.text);
  if (body === null) {
    try {
      return { kind: "not-substantive", payload: await api.loadStory(request.storyId) };
    } catch (error) {
      return { kind: "failed", payload: null, error };
    }
  }
  try {
    const payload = await commitWithConflictRetry(api, request.storyId, body);
    return { kind: "saved", payload };
  } catch (error) {
    const payload = await api.loadStory(request.storyId).catch(() => null);
    return { kind: "failed", payload, error };
  }
}

/** `retryWhenBusy` around each attempt (another window's own claim, or a
 *  `loadStory` residue sweep, can hold the story momentarily); a
 *  `revision_conflict` reloads once and retries exactly once more — the
 *  save is idempotent by `genId`, so a retry after a reload can never
 *  duplicate the take it already half-landed. */
async function commitWithConflictRetry(
  api: StoryApi,
  storyId: string,
  body: CreateNodeRequest
): Promise<StoryPayload> {
  try {
    return await retryWhenBusy(() => api.createNode(storyId, body));
  } catch (error) {
    if (apiErrorCode(error) !== "revision_conflict") throw error;
    // This reload's own payload is deliberately not adopted into the store
    // here (unlike the TUI's `commitNodeAfterReload`, which does adopt it —
    // its own retry can be rebuilt against fresher text, since a stream's
    // buffer is still live at that point). This module has no store to
    // adopt into (it is a pure function over `api`), and every path out of
    // `saveStopped` already ends with a payload that supersedes this one:
    // the retry's own "saved" result on success, or a second, fresher
    // reload in the "failed" outcome on any other failure. The reload here
    // exists only so the retry below is not immediately rejected again by
    // the same staleness.
    await api.loadStory(storyId);
    return await retryWhenBusy(() => api.createNode(storyId, body));
  }
}
