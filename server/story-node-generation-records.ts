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
 * `storePendingGenerationRecords` always drains the exact set (and order)
 * `appendPendingGenerationRecord` queued — one record at a time, only ever
 * dropping a record once its own write durably lands, so a failed write
 * partway through leaves everything after it (and itself) queued for retry
 * instead of vanishing with the in-memory-only bytes behind it.
 */
const pendingGenerationRecords = new WeakMap<StoryNode, GenerationRecord[]>();

/** Refuses once a node's durable history is already at
 *  `MAX_GENERATION_RECORD_IDS`: encode (server/story-format-nodes.ts) enforces
 *  the same bound on decode, so a silent append past it would still reach
 *  disk, then make the manifest unreadable the next time anything parses it.
 *
 *  Every operation that appends a Generation Record to an *existing* node
 *  (a streaming append, an effective in-place rewrite, an existing chapter
 *  summary's refresh) must call this before it starts the paid provider
 *  request, not just at commit time — otherwise a take already at the bound
 *  can stream a full paid generation only to have it discarded when
 *  `appendPendingGenerationRecord` runs during commit. A brand-new take
 *  never has this problem (its node has no history yet), so it needs no
 *  preflight call. `appendPendingGenerationRecord` below still enforces the
 *  same bound at commit time, so a race between two preflighted requests is
 *  still caught. */
export function assertGenerationRecordCapacity(node: StoryNode): void {
  const existing = node.generationRecordIds ?? [];
  if (existing.length >= MAX_GENERATION_RECORD_IDS) {
    throw new ServiceError(400, `This take already has the maximum of ${MAX_GENERATION_RECORD_IDS} Generation Records.`);
  }
}

/** Append a just-captured record's id to the node's durable, ordered history
 *  and queue its bytes for the same commit's encode. The hash is computed
 *  synchronously — serialization is pure and cheap — so the node's id list is
 *  correct immediately, before any object ever reaches disk.
 *
 *  This is the one place every append path funnels through, so the bound
 *  only needs enforcing here at commit time — see `assertGenerationRecordCapacity`
 *  for the pre-provider preflight every append caller must also run. */
export function appendPendingGenerationRecord(node: StoryNode, record: GenerationRecord): string {
  assertGenerationRecordCapacity(node);
  const existing = node.generationRecordIds ?? [];
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
 *  (or when it has none pending at all).
 *
 *  This drops every pending record synchronously, before any of it has
 *  actually reached disk — safe only for a caller that stores the result
 *  itself without ever failing partway through. `encodeStoryBundle` cannot
 *  make that promise (the object store write is an async, fallible I/O
 *  call), so it must use `storePendingGenerationRecords` below instead. This
 *  export remains for callers that only ever inspect or discard the queue
 *  synchronously (tests). */
export function takePendingGenerationRecords(node: StoryNode): readonly GenerationRecord[] {
  const queue = pendingGenerationRecords.get(node);
  if (queue === undefined) return [];
  pendingGenerationRecords.delete(node);
  return queue;
}

/** Store every pending record queued for one node, removing each from the
 *  queue only once its own write has actually settled — so a transient
 *  failure partway through a node's queue (or before any of it starts)
 *  leaves every unwritten record queued for the next encode of the same
 *  Story object, while every record this call already wrote can never be
 *  re-queued and re-sent by a later retry or an unrelated encode. This is
 *  what makes commit-time persistence retryable at this boundary: the
 *  in-memory queue is the only copy of a record's bytes, so it must survive
 *  every record `store` has not yet durably written, across as many retries
 *  as it takes.
 *
 *  `store` does not need to be idempotent for this function's correctness —
 *  a record already shifted off the queue is never sent again — but
 *  `StoryObjectStore.storeGenerationRecord` happens to be one anyway
 *  (content-addressed), so a caller that retries a whole failed encode from
 *  scratch after some other node's write also failed does not have to worry
 *  about which of this node's records already landed. */
export async function storePendingGenerationRecords(
  node: StoryNode,
  store: (record: GenerationRecord) => Promise<unknown>
): Promise<void> {
  const queue = pendingGenerationRecords.get(node);
  if (queue === undefined) return;
  while (queue.length > 0) {
    await store(queue[0]!);
    queue.shift();
  }
  pendingGenerationRecords.delete(node);
}
