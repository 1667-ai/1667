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

type ObjectKind = "chunks" | "revisions";
const OBJECT_IO_CONCURRENCY = 16;
const REVISION_IO_CONCURRENCY = 4;
const TEXT_IO_CONCURRENCY = 4;
const MAX_REVISION_BYTES = MAX_CHUNKS_PER_REVISION * 67 + 256;
const OBJECT_TEMP_PATTERN = exactStringPattern(
  "\\.1667-([a-f0-9]{64})-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.tmp"
);
const SHARD_PATTERN = exactStringPattern("[a-f0-9]{2}");

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
    revisions: new Set()
  };
  private readonly pendingObjects: Record<ObjectKind, Map<ObjectHash, Promise<void>>> = {
    chunks: new Map(),
    revisions: new Map()
  };
  private readonly knownRevisions = new Map<ObjectHash, TextRevisionV1>();
  private readonly dirtyShards = new Set<string>();
  private firstWriteBarrier: Promise<void> | null = null;

  constructor(
    readonly bundleDir: string,
    private readonly linkObject: typeof link = link,
    /** Awaited exactly once before this instance's first object write lands,
     * so callers can publish durable recovery intent only for mutations that
     * actually create objects. */
    private readonly beforeFirstWrite?: () => Promise<void>
  ) {}

  async init(): Promise<void> {
    await this.ensureBundleDirectory();
    await drainPromises([
      this.withKind("chunks", true, async () => undefined),
      this.withKind("revisions", true, async () => undefined)
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

  async sweep(liveRevisionIds: readonly ObjectHash[], signal?: AbortSignal): Promise<boolean> {
    try {
      requireSweepActive(signal);
      const liveRevisions = new Set(liveRevisionIds.map((hash) => requireHash(hash, "live revision id")));
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

      requireSweepActive(signal);
      await drainPromises([
        this.sweepKind("revisions", liveRevisions, signal),
        this.sweepKind("chunks", liveChunks, signal)
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
  async verifyGraph(liveRevisionIds: readonly ObjectHash[]): Promise<void> {
    const revisionIds = [...new Set(liveRevisionIds.map((hash) => requireHash(hash, "live revision id")))];
    const cache = createStoryReadCache();
    const chunkIds = new Set<ObjectHash>();
    const unverified: ObjectHash[] = [];
    for (const hash of revisionIds) {
      if (this.verifiedObjects.revisions.has(hash)) {
        // A verified revision without a known body was adopted from the
        // committed manifest; its chunks were verified before that manifest
        // could publish, so there is nothing left to enumerate.
        const known = this.knownRevisions.get(hash);
        if (known !== undefined) {
          for (const chunkHash of known.chunks) chunkIds.add(chunkHash);
        }
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
  }

  objectPath(kind: ObjectKind, hash: ObjectHash): string {
    requireHash(hash, `${kind} object id`);
    const extension = kind === "chunks" ? ".txt" : ".json";
    return path.join(this.bundleDir, kind, hash.slice(0, 2), `${hash}${extension}`);
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

  /** Trust bare revision ids published by the currently committed manifest.
   * Every id a manifest references was verified before that manifest could
   * publish, so those objects are durable even when this session never read
   * their bodies; verifyGraph re-reads only ids outside the committed set. */
  adoptCommittedRevisionIds(revisionIds: readonly ObjectHash[]): void {
    for (const hash of revisionIds) {
      this.verifiedObjects.revisions.add(requireHash(hash, "committed revision id"));
    }
  }

  verifiedRevisionGraph(): ReadonlyMap<ObjectHash, TextRevisionV1> {
    return new Map(this.knownRevisions);
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
      const limit = kind === "chunks" ? MAX_CHUNK_BYTES : MAX_REVISION_BYTES;
      bytes = await this.withShard(kind, hash, false, async (directory) =>
        await readBoundedFile(
          path.join(directory.path, objectFilename(kind, hash)),
          limit,
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
                    const hash = entry.name.endsWith(
                      kind === "chunks" ? ".txt" : ".json"
                    )
                      ? entry.name.slice(
                          0,
                          -(kind === "chunks" ? ".txt" : ".json").length
                        )
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

class SweepCancelled extends Error {}

function requireSweepActive(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new SweepCancelled();
}

async function readIfPresent(file: string, maxBytes: number, label: string): Promise<Buffer | null> {
  try {
    return await readBoundedFile(file, maxBytes, label);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function verifyExactObject(
  actual: Buffer,
  expected: Buffer,
  kind: ObjectKind,
  hash: ObjectHash
): void {
  if (sha256(actual) !== hash || !actual.equals(expected)) {
    throw new StoryFormatError(`Existing ${kind} object is corrupt: ${hash}`);
  }
}

function objectFilename(kind: ObjectKind, hash: ObjectHash): string {
  return `${hash}${kind === "chunks" ? ".txt" : ".json"}`;
}

function isLinkFallback(error: unknown): boolean {
  return ["EXDEV", "EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "ENOENT"]
    .some((code) => isErrorCode(error, code));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function drainPromises(promises: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(promises);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}
