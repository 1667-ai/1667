import type { StoryNode } from "../shared/types.js";
import {
  alignTokenProbabilities,
  createTokenProbabilities,
  type CapturedTokenProbabilities,
  type TokenProbabilityRecord
} from "../shared/token-probabilities.js";

/**
 * Commit-time token-probability logic (issue #291 phases 3 and its addendum):
 * placing a just-captured record inside the take's stored text and handing
 * it to the same-commit encode. Split out of server/story-node-text.ts
 * (issue #291 structural review, finding F7) because none of this is stub-
 * text projection — it lives here only because the WeakMap below does.
 * `reusableTokenProbabilityId` stays in story-node-text.ts: it reads
 * `storedText`, the stub-projection state this module has nothing to do
 * with.
 */

/** A continuation that captured token probabilities attaches the record to
 *  its freshly created node the instant it commits (server/story-provider-
 *  effect.ts, server/story-nodes.ts). The record is deliberately never a
 *  property of StoryNode itself — a payload projection that shallow-copies a
 *  node (buildStoryPayload's `path`) must never be able to leak it onto the
 *  wire — so this side table is the only place it lives before
 *  encodeStoryBundle turns it into a stored object and clears the entry. */
const pendingTokenProbabilities = new WeakMap<StoryNode, TokenProbabilityRecord>();

/** Attach a just-captured record to a brand-new node, exactly once, before
 *  the same commit's encode consumes it (issue #291 phase 3). */
export function attachPendingTokenProbabilities(node: StoryNode, record: TokenProbabilityRecord): void {
  pendingTokenProbabilities.set(node, record);
}

/** Consume and clear the pending record so a later, unrelated encode of the
 *  same long-lived Story object can never store it twice. */
export function takePendingTokenProbabilities(node: StoryNode): TokenProbabilityRecord | undefined {
  const record = pendingTokenProbabilities.get(node);
  if (record !== undefined) pendingTokenProbabilities.delete(node);
  return record;
}

/** Align a just-captured record to the text a take actually stored, and
 *  attach it only when the two can be reconciled (issue #291 addendum). Both
 *  a genuinely new take and an append call this — `storedSegment` and
 *  `segmentStart` are what differ between them, see the two call sites in
 *  server/story-nodes.ts and server/story-provider-effect.ts.
 *
 *  When alignment fails, this leaves the node exactly as it was: nothing new
 *  is attached, and whatever was already pending (or already stored, from an
 *  earlier take of the same node) is untouched. That matters for a second
 *  append whose own recording cannot be aligned — the first append's record
 *  simply keeps describing the text it already honestly describes, rather
 *  than being cleared to match a "most recent generation" that itself
 *  produced nothing storable.
 *
 *  A later, alignable append does replace it: `attachPendingTokenProbabilities`
 *  overwrites the WeakMap entry, and the next encode stores the new object
 *  under a fresh hash rather than reusing the old one — so the viewer always
 *  shows the most recent generation that actually aligned, never a merge of
 *  several. */
export function attachTakeTokenProbabilities(
  node: StoryNode,
  captured: CapturedTokenProbabilities,
  storedSegment: string,
  segmentStart: number
): void {
  const aligned = alignTokenProbabilities(captured.steps, storedSegment, segmentStart);
  if (aligned === null) return;
  let record: TokenProbabilityRecord;
  try {
    record = createTokenProbabilities(
      { requested: captured.requested, steps: aligned.steps, truncated: captured.truncated },
      aligned.textOffset
    );
  } catch {
    // Token probabilities are a diagnostic, never a reason to fail the
    // generation itself. Alignment only narrows a capture whose per-step
    // bounds were already enforced while it was recorded (server/token-
    // probability-capture.ts), so this guards the one bound narrowing
    // cannot itself satisfy — the aggregate byte size — rather than an
    // expected path.
    return;
  }
  attachPendingTokenProbabilities(node, record);
  node.tokenProbabilities = true;
}
