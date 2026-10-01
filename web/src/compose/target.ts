import { continuationIntent } from "../../../shared/continuation-intent.js";
import type { StoryPayload } from "../../../shared/types.js";

/**
 * The line under the composer that says where a send will land, read from
 * the same `continuationIntent` the send itself uses — so the words never
 * disagree with what happens.
 */
export function continuationTargetLabel(
  payload: StoryPayload,
  focusedPartId: string | null,
  typedText: string
): string {
  const path = payload.path;
  if (path.length === 0) return "→ the first part";
  const intent = continuationIntent(payload, focusedPartId, typedText);
  if (intent.appendLast) return `→ continues part ${path.length}`;
  if (intent.fromSeam) return `→ new take of part ${intent.focusPathIndex + 2}`;
  return `→ after part ${path.length}`;
}
