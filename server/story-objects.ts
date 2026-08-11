import {
  link,
  lstat,
  readdir,
  unlink
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mapWithConcurrency } from "./concurrency.js";
import {
  StoryFormatError,
  HASH_PATTERN,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_REVISION,
  chunkId,
  chunkText,
  createRevision,
  parseRevision,
  requireHash,
  revisionId,
  serializeRevision,
  sha256,
  type ObjectHash,
  type TextRevisionV1
} from "./story-format.js";
import { syncDirectory, writeSyncedFile } from "./story-lifecycle.js";
import { readBoundedFile } from "./bounded-file.js";
import { exactStringPattern } from "./story-wire-patterns.js";
import { RetainedStoryObjectDirectory } from "./story-object-directory.js";
import {
  MAX_TOKEN_PROBABILITY_BYTES,
  parseTokenProbabilities,
  serializeTokenProbabilities,
  type TokenProbabilityRecord
} from "../shared/token-probabilities.js";
import {
  generationRecordSourceRevisionIds,
  MAX_GENERATION_RECORD_BYTES,
  parseGenerationRecord,
  serializeGenerationRecord,
  type GenerationRecord
} from "../shared/generation-record.js";
import {
  MAX_REASONING_BYTES,
  parseReasoning,
  serializeReasoning,
  type ReasoningRecord
} from "../shared/reasoning.js";
import { MAX_IMAGE_OBJECT_BYTES } from "../shared/image-attachment.js";
import {
  drainPromises,
  isErrorCode,
  isLinkFallback,
  objectFilename,
  OBJECT_EXTENSIONS,
  readIfPresent,
  requireSweepActive,
  SweepCancelled,
  verifyExactObject,
  type ObjectKind
} from "./story-object-fs.js";

export type { ObjectKind } from "./story-object-fs.js";
/** The object kinds that are leaves: no nested graph to enumerate, unlike a
 *  revision's chunks — a bare id is the whole story for either kind.
 *  Generation records are not a leaf: a record can reference further
 *  revision ids of its own, so it keeps its own mark-phase handling in
 *  `sweep`/`verifyGraph` below instead of joining this list. The next side
 *  record that fits the true-leaf shape is a one-line addition here plus a
 *  `store`/`read` pair on the store below; `sweep`, `verifyGraph`, and
 *  `readObject` need no further changes.
 *
 *  `images` joined this list once a manifest could name an Image Object
 *  (`nodes[].imageAttachments[].objectId`, server/story-format-nodes.ts).
 *  Unlike the other two kinds, an image can also be live through a Draft
 *  Lease that names no manifest node yet; the caller (server/stories.ts's
 *  `unionLiveWithPins`) folds those lease-sourced ids into `live.leaves.images`
 *  before calling `sweep` below, so this one list still protects every image
 *  an object store method needs to protect. */
export const LEAF_OBJECT_KINDS = ["probabilities", "reasoning", "images"] as const;
export type LeafObjectKind = typeof LEAF_OBJECT_KINDS[number];
/** The label `requireHash` reports for one leaf kind's live id, kept apart
 *  from `COMMITTED_ID_LABELS` below: that one names a *committed* id, this
 *  one a *live* id, and the two read differently in a thrown message. */
const LEAF_LIVE_ID_LABELS: Record<LeafObjectKind, string> = {
  probabilities: "live token probabilities id",
  reasoning: "live reasoning id",
  images: "live image id"
};
/** Every hash a save must protect from a concurrent sweep: the live
 *  revision graph, per leaf kind the live leaf objects, and the live
 *  Generation Record objects. Kept as one object, not positional lists, so a
 *  call site can never update one without the others. */
export interface LiveStoryObjectIds {
  readonly revisions: readonly ObjectHash[];
  readonly leaves: Readonly<Record<LeafObjectKind, readonly ObjectHash[]>>;
  readonly generationRecords: readonly ObjectHash[];
}
const OBJECT_IO_CONCURRENCY = 16;
const REVISION_IO_CONCURRENCY = 4;
const TEXT_IO_CONCURRENCY = 4;
const MAX_REVISION_BYTES = MAX_CHUNKS_PER_REVISION * 67 + 256;
/** Per-kind byte ceiling for one stored object, read by `readObject` — a
 *  table lookup rather than a kind chain, so an added kind is one more row
 *  here instead of one more branch there. */
const OBJECT_MAX_BYTES: Record<ObjectKind, number> = {
  chunks: MAX_CHUNK_BYTES,
  revisions: MAX_REVISION_BYTES,
  probabilities: MAX_TOKEN_PROBABILITY_BYTES,
  reasoning: MAX_REASONING_BYTES,
  images: MAX_IMAGE_OBJECT_BYTES,
  "generation-records": MAX_GENERATION_RECORD_BYTES
};
const OBJECT_TEMP_PATTERN = exactStringPattern(
  "\\.1667-([a-f0-9]{64})-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.tmp"
);
const SHARD_PATTERN = exactStringPattern("[a-f0-9]{2}");
/** Exact wording preserved per kind from before `adoptCommittedIds` unified
 *  the two revision/probabilities methods it replaces; `chunks` is unused
 *  today (nothing yet calls `adoptCommittedIds("chunks", ...)`) but keeps the
 *  table complete for `ObjectKind`. */
const COMMITTED_ID_LABELS: Record<ObjectKind, string> = {
  chunks: "committed chunk id",
  revisions: "committed revision id",
  probabilities: "committed token probabilities id",
  reasoning: "committed reasoning id",
  images: "committed image id",
  "generation-records": "committed generation record id"
};

export interface StoryObjectStoreOptions {
  /** Injectable hard-link primitive for reuse-path failure simulation. */
  readonly linkObject?: typeof link;
  /** Awaited exactly once before this instance's first object write lands,
   * so callers can publish durable recovery intent only for mutations that
   * actually create objects. */
  readonly beforeFirstWrite?: () => Promise<void>;
}

export interface StoryReadCache {
  chunks: Map<ObjectHash, string>;
  revisions: Map<ObjectHash, TextRevisionV1>;
  pendingChunks: Map<ObjectHash, Promise<string>>;
  pendingRevisions: Map<ObjectHash, Promise<TextRevisionV1>>;
}

export function createStoryReadCache(): StoryReadCache {
  return {
    chunks: new Map(),
    revisions: new Map(),
    pendingChunks: new Map(),
    pendingRevisions: new Map()
  };
}

/** Immutable content objects owned by one self-contained story bundle. */
export class StoryObjectStore {
  private readonly verifiedObjects: Record<ObjectKind, Set<ObjectHash>> = {
    chunks: new Set(),
    revisions: new Set(),
    probabilities: new Set(),
    reasoning: new Set(),
    images: new Set(),
    "generation-records": new Set()
  };
  private readonly pendingObjects: Record<ObjectKind, Map<ObjectHash, Promise<void>>> = {
    chunks: new Map(),
    revisions: new Map(),
    probabilities: new Map(),
    reasoning: new Map(),
    images: new Map(),
    "generation-records": new Map()
  };
  private readonly knownRevisions = new Map<ObjectHash, TextRevisionV1>();
  /** Every live generation record's own referenced revision ids, cached by
   * this record's hash so a sweep and a same-save verifyGraph never parse the
   * same record object twice. Populated whenever a record is stored or read,
   * so a record this instance just wrote never needs a read-back to learn
   * what it already knows. */
  private readonly knownGenerationRecordSourceRevisions = new Map<ObjectHash, readonly ObjectHash[]>();
  /** Bare ids adopted from the currently committed manifest, kept apart by
   * object kind like `verifiedObjects` and `pendingObjects` above. Their
   * bodies were never read by this instance, so they are held apart from
   * `verifiedObjects`, which only ever contains hashes proven against bytes.
   * A probabilities or reasoning object has no nested graph to enumerate —
   * each is a leaf, unlike a revision's chunks — so a bare id is all there is
   * to adopt for either kind. A generation-records object can reference
   * further revision ids of its own (`generationRecordSourceRevisionIds`), so
   * adopting its bare id does not exempt those referenced revisions from
   * verification — only the record object itself. */
  private readonly trustedCommitted: Record<ObjectKind, Set<ObjectHash>> = {
    chunks: new Set(),
    revisions: new Set(),
    probabilities: new Set(),
    reasoning: new Set(),
    images: new Set(),
    "generation-records": new Set()
  };
  private readonly dirtyShards = new Set<string>();
  private firstWriteBarrier: Promise<void> | null = null;
  private readonly linkObject: typeof link;
  private readonly beforeFirstWrite?: () => Promise<void>;

  constructor(
    readonly bundleDir: string,
    options: StoryObjectStoreOptions = {}
  ) {
    this.linkObject = options.linkObject ?? link;
    this.beforeFirstWrite = options.beforeFirstWrite;
  }

  async init(): Promise<void> {
    await this.ensureBundleDirectory();
    await drainPromises([
      this.withKind("chunks", true, async () => undefined),
      this.withKind("revisions", true, async () => undefined),
      this.withKind("probabilities", true, async () => undefined),
      this.withKind("reasoning", true, async () => undefined),
      this.withKind("images", true, async () => undefined),
      this.withKind("generation-records", true, async () => undefined)
    ]);
  }

  async storeText(text: string, reuseFrom?: StoryObjectStore): Promise<ObjectHash> {
    const chunks = chunkText(text);
    const hashes = await mapWithConcurrency(chunks, OBJECT_IO_CONCURRENCY, async (chunk) => {
      const hash = chunkId(chunk);
      await this.putObject("chunks", hash, Buffer.from(chunk, "utf8"), reuseFrom);
      return hash;
    });
    const revision = createRevision(hashes, text.length);
    const raw = serializeRevision(revision);
    const hash = revisionId(revision);
    await this.putObject("revisions", hash, Buffer.from(raw, "utf8"), reuseFrom);
    this.knownRevisions.set(hash, revision);
    return hash;
  }

  async storeTexts(texts: readonly string[], reuseFrom?: StoryObjectStore): Promise<ObjectHash[]> {
    return await mapWithConcurrency(texts, TEXT_IO_CONCURRENCY, (text) => this.storeText(text, reuseFrom));
  }

  /** A take's captured token probabilities, content-addressed like text but
   * stored as one leaf object with no chunking: the record is already bounded
   * to `MAX_TOKEN_PROBABILITY_BYTES`, far below a chunk's own ceiling. */
  async storeTokenProbabilities(
    record: TokenProbabilityRecord,
    reuseFrom?: StoryObjectStore
  ): Promise<ObjectHash> {
    const bytes = Buffer.from(serializeTokenProbabilities(record), "utf8");
    const hash = sha256(bytes);
    await this.putObject("probabilities", hash, bytes, reuseFrom);
    return hash;
  }

  /** Bounded, hash-verified read of one take's stored token probabilities.
   * Read at most once per request (the token probability viewer's GET
   * route reads exactly one take), so unlike chunks and revisions this needs
   * no cache. */
  async readTokenProbabilities(hash: ObjectHash): Promise<TokenProbabilityRecord> {
    const bytes = await this.readObject("probabilities", hash);
    return parseTokenProbabilities(bytes.toString("utf8"), hash);
  }

  /** A take's captured reasoning, stored the same way as token probabilities:
   * one leaf object with no chunking, already bounded to
   * `MAX_REASONING_BYTES`, far below a chunk's own ceiling. */
  async storeReasoning(record: ReasoningRecord, reuseFrom?: StoryObjectStore): Promise<ObjectHash> {
    const bytes = Buffer.from(serializeReasoning(record), "utf8");
    const hash = sha256(bytes);
    await this.putObject("reasoning", hash, bytes, reuseFrom);
    return hash;
  }

  /** Bounded, hash-verified read of one take's stored reasoning. Read at most
   * once per request, for the same reason as `readTokenProbabilities`. */
  async readReasoning(hash: ObjectHash): Promise<ReasoningRecord> {
    const bytes = await this.readObject("reasoning", hash);
    return parseReasoning(bytes.toString("utf8"), hash);
  }

  /** One Normalized Image's raw bytes, content-addressed like every other
   * object kind but with no JSON codec: the bytes stored are exactly the
   * bytes a caller hands in, hashed as-is. Both Draft Image staging
   * (server/stories.ts's `stageImage`) and a committed take's own object
   * (referenced from `nodes[].imageAttachments[].objectId`, protected by
   * `manifestImageIds` in server/story-format-nodes.ts) write through here. */
  async storeImage(bytes: Buffer, reuseFrom?: StoryObjectStore): Promise<ObjectHash> {
    const hash = sha256(bytes);
    await this.putObject("images", hash, bytes, reuseFrom);
    return hash;
  }

  /** Bounded, hash-verified read of one Normalized Image's raw bytes. */
  async readImage(hash: ObjectHash): Promise<Buffer> {
    return await this.readObject("images", hash);
  }

  /** One Generation Record event, content-addressed like a probabilities
   * object: a bounded leaf with no chunking. */
  async storeGenerationRecord(
    record: GenerationRecord,
    reuseFrom?: StoryObjectStore
  ): Promise<ObjectHash> {
    const bytes = Buffer.from(serializeGenerationRecord(record), "utf8");
    const hash = sha256(bytes);
    await this.putObject("generation-records", hash, bytes, reuseFrom);
    this.knownGenerationRecordSourceRevisions.set(hash, generationRecordSourceRevisionIds(record));
    return hash;
  }

  /** Bounded, hash-verified read of one Generation Record. Read on demand —
   * the record viewer's GET route reads exactly one — so this needs no
   * cache beyond the source-revision-id memo `generationRecordSourceRevisions`
   * keeps for sweep and verifyGraph. */
  async readGenerationRecord(hash: ObjectHash): Promise<GenerationRecord> {
    const bytes = await this.readObject("generation-records", hash);
    const record = parseGenerationRecord(bytes.toString("utf8"), hash);
    this.knownGenerationRecordSourceRevisions.set(hash, generationRecordSourceRevisionIds(record));
    return record;
  }

  /** The revision ids one Generation Record references, from cache when this
   * instance already read that record this session. A generation-records
   * object is not a leaf the way probabilities and reasoning are — it can
   * name further revisions sweep and verifyGraph must also keep live — so,
   * unlike a leaf kind, its content must be resolved at least once every
   * session rather than trusted bare from a committed manifest. */
  private async generationRecordSourceRevisions(hash: ObjectHash): Promise<readonly ObjectHash[]> {
    const known = this.knownGenerationRecordSourceRevisions.get(hash);
    if (known !== undefined) return known;
    const record = await this.readGenerationRecord(hash);
    return this.knownGenerationRecordSourceRevisions.get(hash) ?? generationRecordSourceRevisionIds(record);
  }

  async readText(hash: ObjectHash, cache = createStoryReadCache()): Promise<string> {
    const revision = await this.readRevision(hash, cache);
    const chunks = await mapWithConcurrency(revision.chunks, OBJECT_IO_CONCURRENCY, (chunkHash) =>
      this.readChunk(chunkHash, cache)
    );
    const text = chunks.join("");
    if (text.length !== revision.utf16Length) {
      throw new StoryFormatError(`Revision length mismatch: ${hash}`);
    }
    return text;
  }

  async readTexts(hashes: readonly ObjectHash[], cache = createStoryReadCache()): Promise<string[]> {
    return await mapWithConcurrency(hashes, TEXT_IO_CONCURRENCY, (hash) => this.readText(hash, cache));
  }

  /**
   * `live.leaves.images` carries every Image Object this sweep must protect:
   * every id a manifest node's `imageAttachments[].objectId` names
   * (server/story-format-nodes.ts's `manifestImageIds`, folded into
   * `liveObjectIds`) plus every id a live Draft Lease references. Images are
   * a leaf kind exactly like `probabilities` and `reasoning`, so this method
   * treats all three identically; the caller (server/stories.ts's
   * `unionLiveWithPins`) is the one place that folds a lease-sourced id into
   * `leaves.images` before calling this, so "an object is live when the
   * manifest names it or a lease does" is decided once, in the module that
   * owns lease lifetime, rather than here.
   */
  async sweep(live: LiveStoryObjectIds, signal?: AbortSignal): Promise<boolean> {
    try {
      requireSweepActive(signal);
      const liveGenerationRecords = new Set(
        live.generationRecords.map((hash) => requireHash(hash, "live generation record id"))
      );
      // Reading every live generation record is itself part of the mark
      // phase: a record can name a revision no current node points at
      // anymore, and that revision must join the live set before the chunk
      // enumeration below, or a rewritten node's superseded text would be
      // swept out from under the history that still describes it. A record
      // that fails to read fails the whole sweep closed, same as a damaged
      // revision would.
      const recordRevisionLists = await mapWithConcurrency(
        [...liveGenerationRecords],
        OBJECT_IO_CONCURRENCY,
        async (hash) => {
          requireSweepActive(signal);
          return await this.generationRecordSourceRevisions(hash);
        }
      );
      const liveRevisions = new Set([
        ...live.revisions.map((hash) => requireHash(hash, "live revision id")),
        ...recordRevisionLists.flat()
      ]);
      const liveLeaves = {} as Record<LeafObjectKind, Set<ObjectHash>>;
      for (const kind of LEAF_OBJECT_KINDS) {
        liveLeaves[kind] = new Set(live.leaves[kind].map((hash) => requireHash(hash, LEAF_LIVE_ID_LABELS[kind])));
      }
      const liveChunks = new Set<ObjectHash>();
      const cache = createStoryReadCache();

      // Complete the mark phase before deleting anything. A damaged live graph must
      // fail closed so cleanup can never make recovery harder.
      const revisions = await mapWithConcurrency([...liveRevisions], REVISION_IO_CONCURRENCY, (hash) => {
        requireSweepActive(signal);
        const known = this.knownRevisions.get(hash);
        return known === undefined ? this.readRevision(hash, cache) : Promise.resolve(known);
      });
      for (const revision of revisions) {
        requireSweepActive(signal);
        for (const chunkHash of revision.chunks) liveChunks.add(chunkHash);
      }
      await mapWithConcurrency([...liveChunks], OBJECT_IO_CONCURRENCY, async (hash) => {
        requireSweepActive(signal);
        await this.requireObject("chunks", hash);
      });
      // A leaf object has nothing beneath it to mark; the read-and-hash-verify
      // below both proves it survives and, on corruption, fails the whole
      // sweep closed exactly like a chunk would. This also covers every
      // Image Object a live Draft Lease references but no manifest node
      // does yet, since `liveLeaves.images` already carries those ids too.
      for (const kind of LEAF_OBJECT_KINDS) {
        await mapWithConcurrency([...liveLeaves[kind]], OBJECT_IO_CONCURRENCY, async (hash) => {
          requireSweepActive(signal);
          await this.requireObject(kind, hash);
        });
      }

      requireSweepActive(signal);
      await drainPromises([
        this.sweepKind("revisions", liveRevisions, signal),
        this.sweepKind("chunks", liveChunks, signal),
        this.sweepKind("generation-records", liveGenerationRecords, signal),
        ...LEAF_OBJECT_KINDS.map((kind) => this.sweepKind(kind, liveLeaves[kind], signal))
      ]);
      return true;
    } catch (error) {
      if (error instanceof SweepCancelled) return false;
      throw error;
    }
  }

  /** Revalidate reused objects against the current filesystem before a
   * manifest can publish their IDs. Objects this instance already verified —
   * fresh writes, hydration reads, or a committed graph adopted from the
   * current manifest's snapshot — are durable; only ids outside that set are
   * read back, so save cost scales with changed objects, not story size. */
  async verifyGraph(live: LiveStoryObjectIds): Promise<void> {
    const generationRecordIds = [
      ...new Set(live.generationRecords.map((hash) => requireHash(hash, "live generation record id")))
    ];
    // Resolving every live generation record's source revisions here, before
    // the revision pass below, guarantees each is verified at least once this
    // session and folds any revision it references into the same pass —
    // mirrors sweep()'s mark phase, so the two never disagree about which
    // revisions a save must keep.
    const recordRevisionLists = await mapWithConcurrency(generationRecordIds, OBJECT_IO_CONCURRENCY, (hash) =>
      this.generationRecordSourceRevisions(hash)
    );
    const revisionIds = [...new Set([
      ...live.revisions.map((hash) => requireHash(hash, "live revision id")),
      ...recordRevisionLists.flat()
    ])];
    const cache = createStoryReadCache();
    const chunkIds = new Set<ObjectHash>();
    const unverified: ObjectHash[] = [];
    for (const hash of revisionIds) {
      const known = this.knownRevisions.get(hash);
      if (known !== undefined && this.verifiedObjects.revisions.has(hash)) {
        for (const chunkHash of known.chunks) chunkIds.add(chunkHash);
      } else if (this.trustedCommitted.revisions.has(hash)) {
        // A bare committed id: its body and chunks were verified before the
        // committed manifest could publish, so nothing is left to enumerate.
      } else {
        unverified.push(hash);
      }
    }
    const revisions = await mapWithConcurrency(unverified, REVISION_IO_CONCURRENCY, (hash) =>
      this.readRevision(hash, cache)
    );
    for (const [index, hash] of unverified.entries()) {
      this.knownRevisions.set(hash, revisions[index]!);
      for (const chunkHash of revisions[index]!.chunks) chunkIds.add(chunkHash);
    }
    await mapWithConcurrency([...chunkIds], OBJECT_IO_CONCURRENCY, (hash) => this.requireObject("chunks", hash));

    for (const kind of LEAF_OBJECT_KINDS) {
      const leafIds = [...new Set(live.leaves[kind].map((hash) => requireHash(hash, LEAF_LIVE_ID_LABELS[kind])))];
      const unverifiedLeaves = leafIds.filter((hash) =>
        !this.verifiedObjects[kind].has(hash) && !this.trustedCommitted[kind].has(hash));
      await mapWithConcurrency(unverifiedLeaves, OBJECT_IO_CONCURRENCY, (hash) =>
        this.requireObject(kind, hash)
      );
    }
  }

  objectPath(kind: ObjectKind, hash: ObjectHash): string {
    requireHash(hash, `${kind} object id`);
    return path.join(this.bundleDir, kind, hash.slice(0, 2), `${hash}${OBJECT_EXTENSIONS[kind]}`);
  }

  /** Flush all newly created object entries before a manifest can reference them. */
  async flush(): Promise<void> {
    const dirty = [...this.dirtyShards].sort();
    for (const key of dirty) {
      const [kind, shard] = key.split(":") as [ObjectKind, string];
      await this.withShardName(kind, shard, false, async (
        shardDirectory,
        kindDirectory
      ) => {
        await syncDirectory(shardDirectory.path);
        await syncDirectory(kindDirectory.path);
      });
    }
    this.dirtyShards.clear();
  }

  /** Reuse identities learned during hydration. With `committed`, the graph
   * comes from a snapshot validated against the currently committed manifest:
   * those objects were verified before that manifest published, so they count
   * as durable and verifyGraph skips re-reading them. */
  adoptKnownGraph(revisions: ReadonlyMap<ObjectHash, TextRevisionV1>, options: { committed?: boolean } = {}): void {
    for (const [hash, revision] of revisions) {
      if (revisionId(revision) !== hash) throw new StoryFormatError(`Invalid adopted revision: ${hash}`);
      this.knownRevisions.set(hash, revision);
      for (const chunkHash of revision.chunks) {
        requireHash(chunkHash, "chunk id");
        if (options.committed === true) this.verifiedObjects.chunks.add(chunkHash);
      }
      if (options.committed === true) this.verifiedObjects.revisions.add(hash);
    }
  }

  /** Trust bare ids published by the currently committed manifest, kept
   * apart by object kind like the rest of this store's per-kind state. Every
   * id a manifest references was verified before that manifest could
   * publish, so those objects are durable even when this session never read
   * their bodies; verifyGraph re-reads only ids outside the committed set. A
   * probabilities object has no chunks to mirror into `verifiedObjects` the
   * way `adoptKnownGraph` does for revisions, so there is nothing else this
   * needs to do for either kind. */
  adoptCommittedIds(kind: ObjectKind, ids: readonly ObjectHash[]): void {
    for (const hash of ids) {
      this.trustedCommitted[kind].add(requireHash(hash, COMMITTED_ID_LABELS[kind]));
    }
  }

  verifiedRevisionGraph(): ReadonlyMap<ObjectHash, TextRevisionV1> {
    return new Map(this.knownRevisions);
  }

  /** Every generation record's source revision ids this instance has
   * resolved so far — each one only ever set from a hash-verified parse
   * (`storeGenerationRecord` or `readGenerationRecord`), never adopted. */
  verifiedGenerationRecordGraph(): ReadonlyMap<ObjectHash, readonly ObjectHash[]> {
    return new Map(this.knownGenerationRecordSourceRevisions);
  }

  /** Reuse generation record source-revision lookups a prior session already
   * hash-verified, so a save with an unchanged manifest never reparses a
   * record it already resolved. A record is immutable and content-addressed,
   * so a hash's source revisions never change — but this only ever accepts a
   * map assembled from `verifiedGenerationRecordGraph`, and only when the
   * caller can assert `committed: true` (the record was live in the
   * currently committed manifest), which is the same trust-by-induction rule
   * `adoptKnownGraph` uses for revisions. Never call this with ids or lists
   * sourced any other way. */
  adoptKnownGenerationRecordGraph(
    sourceRevisions: ReadonlyMap<ObjectHash, readonly ObjectHash[]>,
    options: { committed?: boolean } = {}
  ): void {
    if (options.committed !== true) return;
    for (const [hash, revisionIds] of sourceRevisions) {
      requireHash(hash, "generation record id");
      for (const revisionId of revisionIds) requireHash(revisionId, "revision id");
      this.knownGenerationRecordSourceRevisions.set(hash, revisionIds);
    }
  }

  private async readRevision(hash: ObjectHash, cache: StoryReadCache): Promise<TextRevisionV1> {
    requireHash(hash, "revision id");
    const cached = cache.revisions.get(hash);
    if (cached !== undefined) return cached;
    const pending = cache.pendingRevisions.get(hash);
    if (pending !== undefined) return await pending;
    const operation = (async () => {
      const bytes = await this.readObject("revisions", hash);
      const revision = parseRevision(bytes.toString("utf8"), hash);
      cache.revisions.set(hash, revision);
      return revision;
    })();
    cache.pendingRevisions.set(hash, operation);
    try {
      return await operation;
    } finally {
      if (cache.pendingRevisions.get(hash) === operation) cache.pendingRevisions.delete(hash);
    }
  }

  private async readChunk(hash: ObjectHash, cache: StoryReadCache): Promise<string> {
    requireHash(hash, "chunk id");
    const cached = cache.chunks.get(hash);
    if (cached !== undefined) return cached;
    const pending = cache.pendingChunks.get(hash);
    if (pending !== undefined) return await pending;
    const operation = (async () => {
      const bytes = await this.readObject("chunks", hash);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        throw new StoryFormatError(`Chunk is not valid UTF-8: ${hash}`, { cause: error });
      }
      cache.chunks.set(hash, text);
      return text;
    })();
    cache.pendingChunks.set(hash, operation);
    try {
      return await operation;
    } finally {
      if (cache.pendingChunks.get(hash) === operation) cache.pendingChunks.delete(hash);
    }
  }

  private async readObject(kind: ObjectKind, hash: ObjectHash): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = await this.withShard(kind, hash, false, async (directory) =>
        await readBoundedFile(
          path.join(directory.path, objectFilename(kind, hash)),
          OBJECT_MAX_BYTES[kind],
          `${kind} object ${hash}`
        )
      );
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) throw new StoryFormatError(`Missing ${kind} object: ${hash}`, { cause: error });
      throw error;
    }
    if (sha256(bytes) !== hash) throw new StoryFormatError(`${kind} object hash mismatch: ${hash}`);
    this.verifiedObjects[kind].add(hash);
    return bytes;
  }

  private async requireObject(kind: ObjectKind, hash: ObjectHash): Promise<void> {
    if (this.verifiedObjects[kind].has(hash)) return;
    await this.readObject(kind, hash);
  }

  private async putObject(
    kind: ObjectKind,
    hash: ObjectHash,
    bytes: Buffer,
    reuseFrom?: StoryObjectStore
  ): Promise<void> {
    if (sha256(bytes) !== hash) throw new StoryFormatError(`Refusing inconsistent ${kind} object: ${hash}`);
    if (this.verifiedObjects[kind].has(hash)) return;
    const pending = this.pendingObjects[kind].get(hash);
    if (pending !== undefined) return await pending;
    const operation = this.putObjectOnce(kind, hash, bytes, reuseFrom);
    this.pendingObjects[kind].set(hash, operation);
    try {
      await operation;
    } finally {
      if (this.pendingObjects[kind].get(hash) === operation) this.pendingObjects[kind].delete(hash);
    }
  }

  private async putObjectOnce(
    kind: ObjectKind,
    hash: ObjectHash,
    bytes: Buffer,
    reuseFrom?: StoryObjectStore
  ): Promise<void> {
    await this.withShard(kind, hash, true, async (directory) => {
      const file = path.join(directory.path, objectFilename(kind, hash));
      const existing = await readIfPresent(
        file,
        bytes.length,
        `${kind} object ${hash}`
      );
      if (existing !== null) {
        verifyExactObject(existing, bytes, kind, hash);
        this.verifiedObjects[kind].add(hash);
        return;
      }
      if (this.beforeFirstWrite !== undefined) {
        this.firstWriteBarrier ??= this.beforeFirstWrite();
        await this.firstWriteBarrier;
      }

      if (reuseFrom !== undefined) {
        try {
          const linked = await reuseFrom.withShard(
            kind,
            hash,
            false,
            async (sourceDirectory) => {
              const source = path.join(
                sourceDirectory.path,
                objectFilename(kind, hash)
              );
              const sourceBytes = await readIfPresent(
                source,
                bytes.length,
                `source ${kind} object ${hash}`
              );
              if (sourceBytes === null || !sourceBytes.equals(bytes)) {
                return false;
              }
              await this.linkObject(source, file);
              return true;
            }
          );
          if (linked) {
            this.verifiedObjects[kind].add(hash);
            this.markDirty(kind, hash);
            return;
          }
        } catch (error) {
          if (isErrorCode(error, "EEXIST")) {
            const winner = await readBoundedFile(
              file,
              bytes.length,
              `${kind} object ${hash}`
            );
            verifyExactObject(winner, bytes, kind, hash);
            this.verifiedObjects[kind].add(hash);
            return;
          }
          if (!isLinkFallback(error)) throw error;
        }
      }

      const tmp = path.join(
        directory.path,
        `.1667-${hash}-${randomUUID()}.tmp`
      );
      try {
        await writeSyncedFile(tmp, bytes, "wx");
        try {
          // A hard-link publication is atomic and no-replace on every target
          // where immutable object reuse is supported.
          await link(tmp, file);
        } catch (error) {
          if (!isErrorCode(error, "EEXIST")) throw error;
          const winner = await readBoundedFile(
            file,
            bytes.length,
            `${kind} object ${hash}`
          );
          verifyExactObject(winner, bytes, kind, hash);
        }
        this.verifiedObjects[kind].add(hash);
        this.markDirty(kind, hash);
      } finally {
        await unlink(tmp).catch((error: unknown) => {
          if (!isErrorCode(error, "ENOENT")) throw error;
        });
      }
    });
  }

  private markDirty(kind: ObjectKind, hash: ObjectHash): void {
    this.dirtyShards.add(`${kind}:${hash.slice(0, 2)}`);
  }

  private async sweepKind(kind: ObjectKind, live: ReadonlySet<ObjectHash>, signal?: AbortSignal): Promise<void> {
    requireSweepActive(signal);
    try {
      await this.withKind(kind, false, async (kindDirectory) => {
        const shards = await readdir(kindDirectory.path, {
          withFileTypes: true
        });
        const canonicalShards = [];
        for (const entry of shards) {
          if (!SHARD_PATTERN.test(entry.name)) continue;
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            throw new StoryFormatError(
              `Unsafe ${kind} object shard: ${entry.name}`
            );
          }
          canonicalShards.push(entry.name);
        }
        await mapWithConcurrency(
          canonicalShards,
          OBJECT_IO_CONCURRENCY,
          async (shard) => {
            requireSweepActive(signal);
            await this.withShardName(
              kind,
              shard,
              false,
              async (shardDirectory) => {
                const entries = await readdir(shardDirectory.path, {
                  withFileTypes: true
                });
                await mapWithConcurrency(
                  entries,
                  OBJECT_IO_CONCURRENCY,
                  async (entry) => {
                    requireSweepActive(signal);
                    const temporary = OBJECT_TEMP_PATTERN.exec(entry.name);
                    const extension = OBJECT_EXTENSIONS[kind];
                    const hash = entry.name.endsWith(extension)
                      ? entry.name.slice(0, -extension.length)
                      : null;
                    const removableTemporary =
                      temporary !== null
                        && temporary[1]!.startsWith(shard);
                    const removableObject =
                      hash !== null
                        && HASH_PATTERN.test(hash)
                        && hash.startsWith(shard)
                        && !live.has(hash);
                    if (!removableTemporary && !removableObject) return;
                    if (!entry.isFile() || entry.isSymbolicLink()) {
                      throw new StoryFormatError(
                        `Unsafe ${kind} object entry: ${entry.name}`
                      );
                    }
                    const file = path.join(shardDirectory.path, entry.name);
                    const info = await lstat(file);
                    if (!info.isFile() || info.isSymbolicLink()) {
                      throw new StoryFormatError(
                        `Unsafe ${kind} object entry: ${entry.name}`
                      );
                    }
                    await unlink(file);
                  }
                );
              }
            );
          }
        );
      });
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }

  private async withKind<T>(
    kind: ObjectKind,
    create: boolean,
    work: (directory: RetainedStoryObjectDirectory) => Promise<T>
  ): Promise<T> {
    const bundle = await RetainedStoryObjectDirectory.open(
      this.bundleDir,
      "Story object bundle"
    );
    let directory: RetainedStoryObjectDirectory | undefined;
    try {
      directory = await bundle.child(
        kind,
        create,
        `${kind} object root`
      );
      const value = await work(directory);
      await directory.revalidate();
      await bundle.revalidate();
      return value;
    } finally {
      await directory?.close();
      await bundle.close();
    }
  }

  private async ensureBundleDirectory(): Promise<void> {
    const parent = await RetainedStoryObjectDirectory.open(
      path.dirname(this.bundleDir),
      "Story object bundle parent"
    );
    let bundle: RetainedStoryObjectDirectory | undefined;
    try {
      bundle = await parent.child(
        path.basename(this.bundleDir),
        true,
        "Story object bundle"
      );
      await bundle.revalidate();
      await parent.revalidate();
    } finally {
      await bundle?.close();
      await parent.close();
    }
  }

  private async withShard<T>(
    kind: ObjectKind,
    hash: ObjectHash,
    create: boolean,
    work: (
      shard: RetainedStoryObjectDirectory,
      root: RetainedStoryObjectDirectory
    ) => Promise<T>
  ): Promise<T> {
    requireHash(hash, `${kind} object id`);
    return await this.withShardName(
      kind,
      hash.slice(0, 2),
      create,
      work
    );
  }

  private async withShardName<T>(
    kind: ObjectKind,
    shardName: string,
    create: boolean,
    work: (
      shard: RetainedStoryObjectDirectory,
      root: RetainedStoryObjectDirectory
    ) => Promise<T>
  ): Promise<T> {
    if (!SHARD_PATTERN.test(shardName)) {
      throw new StoryFormatError(`Invalid ${kind} object shard`);
    }
    return await this.withKind(kind, create, async (root) => {
      const shard = await root.child(
        shardName,
        create,
        `${kind} object shard`
      );
      try {
        const value = await work(shard, root);
        await shard.revalidate();
        await root.revalidate();
        return value;
      } finally {
        await shard.close();
      }
    });
  }
}
