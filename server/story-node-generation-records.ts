import { MAX_GENERATION_RECORD_IDS, type StoryNode } from "../shared/types.js";
import { serializeGenerationRecord, type GenerationRecord } from "../shared/generation-record.js";
import { ServiceError } from "./errors.js";
import { sha256 } from "./story-format.js";

/**
 * Commit-time Generation Record plumbing (Generation Records project),
 * mirroring server/story-node-token-probabilities.ts: a record is never a
 * property of StoryNode itself — a payload projection that shallow-copies a
 * node (buildStoryPayload's `path`) must never be able to leak one onto the
 * wire — so this side table is the only place a just-captured record lives
 * before encodeStoryBundle turns it into a stored object and clears the
 * entry. `node.generationRecordIds` carries only the ordered id list; the
 * bytes behind every id this same commit appended live here until the same
 * commit's encode consumes them.
 *
 * Unlike token probabilities (`node.tokenProbabilityId` is a single field —
 * a new one always replaces the last), `node.generationRecordIds` is a
 * durable, ever-growing history: every id ever appended must remain
 * individually readable. A single-slot side table would silently lose an
 * earlier pending record the moment a second one was appended to the same
 * node before an encode drained it — the id would stay in
 * `generationRecordIds` forever, but its bytes would never reach disk. This
 * keeps every pending record queued per node instead, in append order, so
 * `takePendingGenerationRecords` always drains the exact set (and order)
 * `appendPendingGenerationRecord` queued.
 */
const pendingGenerationRecords = new WeakMap<StoryNode, GenerationRecord[]>();

/** Append a just-captured record's id to the node's durable, ordered history
 *  and queue its bytes for the same commit's encode. The hash is computed
 *  synchronously — serialization is pure and cheap — so the node's id list is
 *  correct immediately, before any object ever reaches disk.
 *
 *  Refuses before mutating anything once the node is already at
 *  `MAX_GENERATION_RECORD_IDS`: encode (server/story-format-nodes.ts) enforces
 *  the same bound on decode, so a silent append past it would still reach
 *  disk, then make the manifest unreadable the next time anything parses it.
 *  This is the one place every append path funnels through, so the bound
 *  only needs enforcing here. */
export function appendPendingGenerationRecord(node: StoryNode, record: GenerationRecord): string {
  const existing = node.generationRecordIds ?? [];
  if (existing.length >= MAX_GENERATION_RECORD_IDS) {
    throw new ServiceError(400, `This take already has the maximum of ${MAX_GENERATION_RECORD_IDS} Generation Records.`);
  }
  const hash = sha256(serializeGenerationRecord(record));
  const queue = pendingGenerationRecords.get(node);
  if (queue === undefined) pendingGenerationRecords.set(node, [record]);
  else queue.push(record);
  node.generationRecordIds = [...existing, hash];
  return hash;
}

/** Consume and clear every pending record so a later, unrelated encode of the
 *  same long-lived Story object can never store any of them twice. Empty
 *  when this node's most recent ids were already stored by an earlier encode
 *  (or when it has none pending at all). */
export function takePendingGenerationRecords(node: StoryNode): readonly GenerationRecord[] {
  const queue = pendingGenerationRecords.get(node);
  if (queue === undefined) return [];
  pendingGenerationRecords.delete(node);
  return queue;
}
