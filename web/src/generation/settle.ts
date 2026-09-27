import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import type { CreateNodeRequest, StoryPayload } from "../../../shared/types.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import { hasSubstantiveText, trimmedText } from "./stream-buffer.js";
import type { GenerationMode } from "./state.js";

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
  readonly mode: GenerationMode;
  readonly appendTo: string | null;
  readonly expectedTextHash: string | undefined;
  readonly parentId: string | null;
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
  if (!hasSubstantiveText(request.text)) {
    try {
      return { kind: "not-substantive", payload: await api.loadStory(request.storyId) };
    } catch (error) {
      return { kind: "failed", payload: null, error };
    }
  }
  const body = saveBody(request);
  try {
    const payload = await commitWithConflictRetry(api, request.storyId, body);
    return { kind: "saved", payload };
  } catch (error) {
    const payload = await api.loadStory(request.storyId).catch(() => null);
    return { kind: "failed", payload, error };
  }
}

function saveBody(request: StopSaveRequest): CreateNodeRequest {
  if (request.mode === "append") {
    return {
      appendTo: request.appendTo!,
      expectedTextHash: request.expectedTextHash!,
      instruction: "",
      text: request.text,
      genId: request.genId
    };
  }
  return {
    parentId: request.parentId,
    instruction: request.instruction,
    text: trimmedText(request.text),
    genId: request.genId
  };
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
    await api.loadStory(storyId);
    return await retryWhenBusy(() => api.createNode(storyId, body));
  }
}
