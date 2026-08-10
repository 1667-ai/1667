import type { StoryNode } from "../shared/types.js";
import {
  createReasoningRecord,
  type CapturedReasoning,
  type ReasoningRecord
} from "../shared/reasoning.js";
import { clearReusableReasoningId } from "./story-node-text.js";

/**
 * Commit-time reasoning logic, mirroring
 * server/story-node-token-probabilities.ts exactly: a per-take side record,
 * attached to a freshly committed node the instant the commit that captured
 * it lands, and consumed exactly once by the same-commit encode.
 *
 * Unlike token probabilities, a captured thought needs no alignment against
 * the take's stored text — it is not extracted from inside that text, it is
 * a whole separate channel a generation produced alongside it — so this
 * module has no equivalent of `alignTokenProbabilities`.
 */

/** A continuation, rewrite, or summary take that captured reasoning attaches
 *  the record to its node the instant it commits (server/story-nodes.ts,
 *  server/story-provider-effect.ts). The record is deliberately never a
 *  property of StoryNode itself — a payload projection that shallow-copies a
 *  node must never be able to leak it onto the wire — so this side table is
 *  the only place it lives before encodeStoryBundle turns it into a stored
 *  object and clears the entry. */
const pendingReasoning = new WeakMap<StoryNode, ReasoningRecord>();

/** Attach a just-captured record to a node, exactly once, before the same
 *  commit's encode consumes it. */
export function attachPendingReasoning(node: StoryNode, record: ReasoningRecord): void {
  pendingReasoning.set(node, record);
}

/** Consume and clear the pending record so a later, unrelated encode of the
 *  same long-lived Story object can never store it twice. */
export function takePendingReasoning(node: StoryNode): ReasoningRecord | undefined {
  const record = pendingReasoning.get(node);
  if (record !== undefined) pendingReasoning.delete(node);
  return record;
}

/** Validate a stream's captured reasoning and attach it to the node that
 *  just committed. Retention is decided earlier, when the stream is captured
 *  (`server/reasoning-capture.ts`): a writer who keeps no thoughts produces
 *  no capture, so there is nothing here to refuse. A no-op for an empty
 *  capture (the model produced no reasoning this attempt), and reasoning is
 *  a diagnostic, never a reason to fail the generation: a capture that fails
 *  validation
 *  (the one bound `createReasoningRecord` enforces that a stream cannot
 *  itself satisfy — the aggregate byte size) is silently dropped instead of
 *  thrown. */
export function attachTakeReasoning(node: StoryNode, captured: CapturedReasoning | null | undefined): void {
  if (captured === null || captured === undefined || captured.text.length === 0) return;
  let record: ReasoningRecord;
  try {
    record = createReasoningRecord(captured);
  } catch {
    return;
  }
  attachPendingReasoning(node, record);
  node.reasoning = true;
}

/** Remove any reasoning attached to a node — pending, already stored, or
 *  both — so the next encode carries none forward. A rewrite that replaces a
 *  take's text in place calls this before deciding whether the same attempt
 *  produced a fresh thought to attach: the take's old thought described text
 *  that no longer exists, so leaving it in place would show the wrong
 *  thought for the right take. Append never calls this — an append only
 *  extends a take's text, so an earlier thought still honestly describes the
 *  part of the text that came before it. */
export function clearTakeReasoning(node: StoryNode): void {
  pendingReasoning.delete(node);
  delete node.reasoning;
  clearReusableReasoningId(node);
}
