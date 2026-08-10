import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { activeLineFingerprintSource } from "../shared/story-text.js";
import { activePath, descendantLine, pathTo } from "../shared/story-tree.js";
import {
  type EditNodeRequest,
  type PasteStoryLineRequest,
  type PruneUnusedTakesRequest,
  type Story,
  type StorySummary
} from "../shared/types.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import { ServiceError as HttpError } from "./errors.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  HASH_PATTERN,
  STORY_SCHEMA_VERSION,
  StoryFormatError,
  liveObjectIds,
  parseManifest,
  serializeManifest,
  sha256,
  type ObjectHash,
  type StoredNodeV1,
  type StoryManifestV5
} from "./story-format.js";
import type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../shared/generation-record.js";
import { resolveGenerationRecord } from "./generation-record-resolve.js";
import { decodeStoryBundle, encodeStoryBundle, hydrateStoryNodes } from "./story-codec.js";
import { putStoryTag, removeStoryTag } from "./story-tags.js";
import {
  afterCommit,
  mkdirDurable,
  publishBundle,
  requireDurableCommit,
  stagingBundlePath,
  unpublishBundle,
  unlinkDurable,
  writeDurableAtomic,
  writeDurableFile,
  type CommitResult
} from "./story-lifecycle.js";
import {
  applyHumanEdit,
  assertStoryLineCopySize,
  createTake,
  createTakeFromCut as createCutTake,
  deleteSubtree,
  newNode,
  pasteStoryLine as pasteLineNodes,
  type PasteStoryLineIds,
  pruneUnusedTakes as pruneUnusedStoryTakes,
  requireNode,
  switchLine as switchTreeLine
} from "./story-nodes.js";
import { StoryObjectStore, type LiveStoryObjectIds, type ObjectKind } from "./story-objects.js";
import { KeyedSerialQueue } from "./keyed-serial-queue.js";
import {
  BoundedCleanupQueue,
  STORY_CLEANUP_IO_CONCURRENCY,
  StoryCleanupIntent,
  cleanupPending,
  clearCleanupPending
} from "./story-cleanup.js";
import { captureStorySnapshot, isCurrentSnapshot, type StoryRevisionSnapshot } from "./story-snapshot.js";
import {
  catalogStoryIds,
  readOptionalStoryFile,
  readStoredStorySlot,
  requireMutableStorySlot,
  storyMetadataFromSlot,
  type MutableStorySlot,
  type StoryMetadata,
  type StoredStorySlot
} from "./story-storage-reader.js";
import { buildStorySummary } from "./story-summary.js";
import { storySummaryFromV6 } from "./story-v6-codec.js";
import {
  applyProviderStoryEffect,
  type ProviderStoryEffect,
  type ProviderStoryEffectValue
} from "./story-provider-effect.js";
import {
  hashStoryV5ManifestBytes
} from "./story-manifest-hash.js";
import { isStoryId } from "./story-v5-strict.js";
import {
  requirePresentStorySlot,
  StoryAggregateSession,
  type GenerationRecordSourceRevisionSnapshot
} from "./story-aggregate-session.js";

export const STORY_LIST_IO_CONCURRENCY = 4;
export const STORY_UNCHANGED = Symbol("story-unchanged");

type ResolvedStory = Extract<StoredStorySlot, { kind: "legacy" | "v5" | "v6-live" }>;
type SweepObjects = (bundleDir: string, live: LiveStoryObjectIds, signal: AbortSignal) => Promise<boolean>;
type WriteManifest = (file: string, data: string) => Promise<CommitResult>;
interface SwitchLineOptions { expectedLineFingerprint?: string; stopAtNode?: boolean }
/** One story's provider-snapshot pins, kept apart by object kind — mixing
 * them would protect a revision hash from the probabilities sweep pass (or
 * vice versa), silently defeating the pin. Shaped like StoryObjectStore's own
 * per-kind collections (server/story-objects.ts) for the same reason: only
 * `revisions` and `probabilities` are ever populated (`LiveStoryObjectIds`
 * has no `chunks`), but sharing the kind-generic shape lets `addPins` and
 * `releasePins` run as one loop each instead of one call per kind. */
type ProviderSnapshotPins = Record<ObjectKind, Map<ObjectHash, number>>;
/** The two kinds `LiveStoryObjectIds` ever carries — the subset of
 * `ProviderSnapshotPins`' kinds that pinning and its release loop touch. */
const LIVE_OBJECT_KINDS = ["revisions", "probabilities"] as const satisfies readonly (keyof LiveStoryObjectIds)[];

function emptyProviderSnapshotPins(): ProviderSnapshotPins {
  return { chunks: new Map(), revisions: new Map(), probabilities: new Map(), "generation-records": new Map() };
}

const sweepObjects: SweepObjects = async (bundleDir, live, signal) =>
  await new StoryObjectStore(bundleDir).sweep(live, signal);

export class StoryStore {
  constructor(
    private readonly dir: string,
    private readonly sweep: SweepObjects = sweepObjects,
    private readonly writeManifest: WriteManifest = writeDurableAtomic
  ) {
    this.cleanupQueue = new BoundedCleanupQueue(
      STORY_CLEANUP_IO_CONCURRENCY,
      (storyId, signal) => this.runCleanup(storyId, signal)
    );
  }

  private readonly snapshots = new WeakMap<Story, StoryRevisionSnapshot>();
  private readonly providerSnapshotPins =
    new Map<string, ProviderSnapshotPins>();
  /** One V6 story's last hash-verified generation record source-revision
   *  graph, keyed by story id since a `StoryAggregateSession` is created
   *  fresh for every `withAggregateSession` call and cannot itself carry
   *  state between them. Guarded at adoption time by the manifest hash it
   *  was captured against (`StoryAggregateSession.capturedGenerationRecordGraph`),
   *  so a stale entry here is simply ignored, never trusted. */
  private readonly generationRecordGraphs =
    new Map<string, GenerationRecordSourceRevisionSnapshot>();
  /** One writer at a time per story. Read-modify-write is otherwise not atomic:
   *  a Stop and the stream's own commit can both load an unstamped story, both
   *  decide to write, and race — duplicating a node or losing the other's text.
   *  Everything that mutates a story runs inside this. */
  private readonly mutationQueue = new KeyedSerialQueue();
  /** Files and cleanup also serialize with loads, independently of the larger
   * read-modify-write lock above. This prevents a reader holding an old manifest
   * from racing cleanup of that manifest's objects. */
  private readonly ioQueue = new KeyedSerialQueue();
  private readonly cleanupQueue: BoundedCleanupQueue;

  async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    return await this.mutationQueue.run(id, work);
  }

  async withAggregateSession<T>(
    id: string,
    work: (session: StoryAggregateSession) => Promise<T>
  ): Promise<T> {
    return await this.withLock(id, async () => await this.withIo(id, async () => {
      const slot = await readStoredStorySlot(this.dir, id);
      requirePresentStorySlot(slot, id);
      const session = new StoryAggregateSession(this.dir, id, slot, this.generationRecordGraphs.get(id) ?? null);
      await session.init();
      const result = await work(session);
      this.captureGenerationRecordGraph(id, session);
      await this.schedulePendingCleanup(id);
      return result;
    }));
  }

  async withOptionalAggregateSession<T>(
    id: string,
    work: (session: StoryAggregateSession | null) => Promise<T>
  ): Promise<T> {
    return await this.withLock(id, async () => await this.withIo(id, async () => {
      const slot = await readStoredStorySlot(this.dir, id);
      if (slot.kind === "absent") return await work(null);
      requirePresentStorySlot(slot, id);
      const session = new StoryAggregateSession(this.dir, id, slot, this.generationRecordGraphs.get(id) ?? null);
      await session.init();
      const result = await work(session);
      this.captureGenerationRecordGraph(id, session);
      await this.schedulePendingCleanup(id);
      return result;
    }));
  }

  /** Remember whatever generation record graph this session verified, so the
   *  next session for the same story can skip reparsing unchanged records. A
   *  session that never called prepareContent leaves its captured graph
   *  untouched, so this simply re-stores the same entry — harmless. */
  private captureGenerationRecordGraph(id: string, session: StoryAggregateSession): void {
    if (session.snapshot.manifest.kind !== "live") {
      this.generationRecordGraphs.delete(id);
      return;
    }
    const captured = session.capturedGenerationRecordGraph;
    if (captured !== null) this.generationRecordGraphs.set(id, captured);
  }

  async init(): Promise<void> {
    await mkdirDurable(this.dir);
  }

  /** Wait for best-effort object collection. Production writes do not await it;
   * tests and orderly shutdowns may use this to observe a settled filesystem. */
  async waitForMaintenance(): Promise<void> {
    await this.cleanupQueue.waitForIdle();
  }

  /** Keep an admitted provider snapshot's immutable objects readable while
   * provider preparation runs outside the story claim. Cleanup retains the
   * union of live and pinned revisions and token probability objects until
   * the returned lease is released. */
  pinProviderSnapshot(
    session: StoryAggregateSession
  ): () => void {
    const manifest = session.snapshot.manifest;
    if (manifest.kind !== "live") {
      throw new Error("Cannot pin a deleted provider snapshot");
    }
    const storyId = session.storyId;
    const live = liveObjectIds(manifest.content);
    // Generation Records are never read mid-flight during provider
    // preparation — a record's own object is only created and stored at
    // commit time — so, unlike revisions and probabilities, there is nothing
    // for this in-flight pin to protect for them; the normal current-manifest
    // sweep already keeps a committed record (and, per its own mark phase,
    // any revision it references) live for as long as any node still points
    // at it. `dedupedLive.generationRecords` is carried here only to satisfy
    // LiveStoryObjectIds' shape, not because LIVE_OBJECT_KINDS pins it.
    const dedupedLive: LiveStoryObjectIds = {
      revisions: [...new Set(live.revisions)],
      probabilities: [...new Set(live.probabilities)],
      generationRecords: [...new Set(live.generationRecords)]
    };
    const pins = this.providerSnapshotPins.get(storyId) ?? emptyProviderSnapshotPins();
    this.providerSnapshotPins.set(storyId, pins);
    for (const kind of LIVE_OBJECT_KINDS) addPins(pins[kind], dedupedLive[kind]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const kind of LIVE_OBJECT_KINDS) releasePins(pins[kind], dedupedLive[kind]);
      if (Object.values(pins).every((map) => map.size === 0)) {
        this.providerSnapshotPins.delete(storyId);
      }
      this.cleanupQueue.schedule(storyId);
    };
  }

  /** Keep specific text revisions readable across a gap nothing else
   * bridges: a stop-save Generation Record handoff (server/generation-
   * record-handoff.ts) captures revision ids while `pinProviderSnapshot`'s
   * own lease is still open, but that lease ends with the request that
   * cancelled — long before the client's later, separate stop-save
   * `createNode` call turns the handoff into a committed record. Unlike
   * `pinProviderSnapshot`, this only ever pins the `revisions` kind, and only
   * the ids the caller names, never a whole live snapshot. */
  pinRevisions(storyId: string, revisionIds: readonly ObjectHash[]): () => void {
    if (revisionIds.length === 0) return () => {};
    const pins = this.providerSnapshotPins.get(storyId) ?? emptyProviderSnapshotPins();
    this.providerSnapshotPins.set(storyId, pins);
    addPins(pins.revisions, revisionIds);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releasePins(pins.revisions, revisionIds);
      if (Object.values(pins).every((map) => map.size === 0)) {
        this.providerSnapshotPins.delete(storyId);
      }
      this.cleanupQueue.schedule(storyId);
    };
  }

  async list(): Promise<StorySummary[]> {
    const ids = await catalogStoryIds(this.dir);
    const summaries = await mapWithConcurrency(ids, STORY_LIST_IO_CONCURRENCY, async (id) => this.withIo(id, async () => {
      const slot = await readStoredStorySlot(this.dir, id);
      if (slot.kind === "legacy") return buildStorySummary(slot.story);
      if (slot.kind === "v5") return {
        ...buildStorySummary(slot.manifest),
        aggregateVersion: aggregateVersionFromSlot(slot)
      };
      if (slot.kind === "v6-live") return {
        ...storySummaryFromV6(slot.manifest),
        aggregateVersion: aggregateVersionFromSlot(slot)
      };
      return null;
    }).catch((error: unknown) => {
      console.warn(`Skipping unreadable story file ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }));
    return summaries.filter((summary): summary is StorySummary => summary !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async switchLine(
    id: string,
    nodeId: string,
    options: SwitchLineOptions = {}
  ): Promise<Story> {
    const { expectedLineFingerprint } = options;
    if (expectedLineFingerprint === undefined) {
      return await this.mutate(id, (story) => {
        switchTreeLine(story, nodeId, options);
      });
    }
    if (!HASH_PATTERN.test(expectedLineFingerprint)) throw new HttpError(400, "Invalid expected line fingerprint");
    return await this.withLock(id, async () => {
      const story = await this.loadForMutation(id);
      requireNode(story, nodeId);
      const line = activePath(story);
      if (sha256(activeLineFingerprintSource(story.title, line)) !== expectedLineFingerprint) return story;
      switchTreeLine(story, nodeId, options);
      await this.hydrateNodes(story, activePath(story).map((node) => node.id));
      await this.save(story);
      return story;
    });
  }

  async createNode(id: string, parentId: string | null, text: string, instruction: string): Promise<Story> {
    return await this.mutate(id, (story) => {
      createTake(story, newNode(parentId, instruction, text, "human", { human: true }));
    });
  }

  async createTakeFromCut(
    id: string,
    nodeId: string,
    offset: unknown,
    expected: string | null,
    newNodeId?: string
  ): Promise<Story> {
    return await this.mutate(id, (story) => {
      if (newNodeId !== undefined && story.nodes.some((node) => node.id === newNodeId)) return STORY_UNCHANGED;
      createCutTake(story, nodeId, offset, expected, newNodeId);
    });
  }

  async editNode(id: string, nodeId: string, request: EditNodeRequest): Promise<Story> {
    return await this.mutate(id, async (story) => {
      await this.hydratePath(story, nodeId);
      applyHumanEdit(story, nodeId, request);
    });
  }

  async pasteStoryLine(
    id: string,
    targetParentId: string,
    body: PasteStoryLineRequest,
    ids: PasteStoryLineIds = {}
  ): Promise<Story> {
    return await this.mutate(id, async (story) => {
      const firstCloneId = ids.nodeId?.(0);
      if (firstCloneId !== undefined && story.nodes.some((node) => node.id === firstCloneId)) return STORY_UNCHANGED;
      const sourceLine = descendantLine(story, body.sourceNodeId);
      assertStoryLineCopySize(sourceLine.length);
      await this.hydrateNodes(story, sourceLine.map((node) => node.id));
      pasteLineNodes(story, body.sourceNodeId, targetParentId, body.expectedLeafId, ids);
    });
  }

  async deleteNode(id: string, nodeId: string, expectedSubtreeCount: number): Promise<Story> {
    return await this.mutate(id, (story) => deleteSubtree(story, nodeId, expectedSubtreeCount));
  }

  async pruneUnusedTakes(id: string, expected: PruneUnusedTakesRequest): Promise<Story> {
    return await this.mutate(id, (story) => { pruneUnusedStoryTakes(story, expected); });
  }

  async setTag(id: string, nodeId: string, nameValue: string, labelValue: string): Promise<Story> {
    return await this.mutate(id, (story) => { putStoryTag(story, nodeId, nameValue, labelValue); });
  }

  async deleteBookmark(id: string, nodeId: string): Promise<Story> {
    return await this.mutate(id, (story) => { removeStoryTag(story, nodeId); });
  }

  async commitProviderEffect<Effect extends ProviderStoryEffect>(
    id: string,
    effect: Effect
  ): Promise<ProviderStoryEffectValue<Effect>> {
    return await this.withLock(id, async () => {
      const story = await this.loadForMutation(id);
      const applied = await applyProviderStoryEffect(
        story,
        effect,
        async (current, nodeId) => await this.hydratePath(current, nodeId)
      );
      if (applied.changed) await this.save(story);
      return applied.value;
    });
  }

  async mutate(
    id: string,
    mutation: (story: Story) => void | typeof STORY_UNCHANGED | Promise<void | typeof STORY_UNCHANGED>
  ): Promise<Story> {
    return await this.withLock(id, async () => {
      const story = await this.loadForMutation(id);
      if (await mutation(story) === STORY_UNCHANGED) return story;
      await this.hydrateNodes(story, activePath(story).map((node) => node.id));
      await this.save(story);
      return story;
    });
  }

  async load(id: string): Promise<Story> {
    return await this.withIo(id, async () => {
      const story = await this.loadUnlocked(id);
      await this.schedulePendingCleanup(id);
      return story;
    });
  }

  async loadVersioned(id: string): Promise<{
    story: Story;
    aggregateVersion: StoryAggregateVersion | null;
  }> {
    return await this.withIo(id, async () => {
      const slot = await this.resolveUnlocked(id);
      await this.schedulePendingCleanup(id);
      return {
        story: await this.hydrateResolved(slot),
        aggregateVersion: slot.kind === "legacy" ? null : aggregateVersionFromSlot(slot)
      };
    });
  }

  async schedulePendingCleanup(id: string): Promise<void> {
    if (await cleanupPending(path.join(this.dir, id))) {
      this.cleanupQueue.schedule(id);
    }
  }

  /** Manifest-only lineage metadata for offline planning; never opens objects. */
  async loadMetadata(id: string): Promise<StoryMetadata> {
    return await this.withIo(id, async () => {
      const metadata = storyMetadataFromSlot(await this.resolveUnlocked(id));
      await this.schedulePendingCleanup(id);
      return metadata;
    });
  }

  async loadForMutation(id: string): Promise<Story> {
    return await this.withIo(id, async () => {
      const slot = await readStoredStorySlot(this.dir, id);
      requireMutableStorySlot(slot, id);
      const story = await this.hydrateMutableSlot(slot, id);
      await this.schedulePendingCleanup(id);
      return story;
    });
  }

  /** Admission check for receipt-backed mutations. Reopened again at commit. */
  async assertMutationSupported(id: string): Promise<void> {
    await this.withIo(id, async () => {
      requireMutableStorySlot(await readStoredStorySlot(this.dir, id), id);
    });
  }

  async hydratePath(story: Story, nodeId: string): Promise<void> {
    requireNode(story, nodeId);
    await this.hydrateNodes(story, pathTo(story, nodeId).map((node) => node.id));
  }

  private async hydrateNodes(story: Story, nodeIds: readonly string[]): Promise<void> {
    await this.withIo(story.id, () => hydrateStoryNodes(story, nodeIds));
  }

  /** Manifest-only title and revision stamp. It opens no part text, so a
   *  cached derivation can be revalidated without reading the story. */
  async loadRevision(id: string): Promise<{ title: string; updatedAt: string } | null> {
    return await this.withIo(id, async () => {
      let slot: ResolvedStory;
      try {
        slot = await this.resolveUnlocked(id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
      await this.schedulePendingCleanup(id);
      if (slot.kind === "legacy") {
        return { title: slot.story.title, updatedAt: slot.story.updatedAt };
      }
      const manifest = slot.kind === "v5" ? slot.manifest : slot.manifest.content;
      return { title: manifest.title, updatedAt: manifest.updatedAt };
    });
  }

  /** One take's stored token probabilities, read directly from the manifest
   *  and the object store — never through `Story`/`StoryNode`, which carry
   *  presence only. 404s, distinguishably by message, when the story or the
   *  take is missing and when the take exists but asked for no probabilities. */
  async loadTokenProbabilities(id: string, nodeId: string): Promise<TokenProbabilityRecord> {
    return await this.withIo(id, async () => {
      let slot: ResolvedStory;
      try {
        slot = await this.resolveUnlocked(id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw new HttpError(404, `Take not found: ${nodeId}`);
        throw error;
      }
      await this.schedulePendingCleanup(id);
      if (slot.kind === "legacy") throw new HttpError(404, `Take not found: ${nodeId}`);
      const manifest = slot.kind === "v5" ? slot.manifest : slot.manifest.content;
      const stored = manifest.nodes.find((node) => node.id === nodeId);
      if (stored === undefined) throw new HttpError(404, `Take not found: ${nodeId}`);
      if (stored.tokenProbabilityId === undefined) {
        throw new HttpError(404, "This take has no stored token probabilities.");
      }
      return await new StoryObjectStore(this.bundlePath(id)).readTokenProbabilities(stored.tokenProbabilityId);
    });
  }

  /** Every Generation Record event on one node, oldest first, projected down
   *  to what a history list needs. Reads every record this node has — always
   *  a small, request-bounded set (MAX_GENERATION_RECORD_IDS), never the
   *  whole story — so unlike a single on-demand read this does open more
   *  than one object, exactly the way a history list must. */
  async loadGenerationRecordSummaries(id: string, nodeId: string): Promise<GenerationRecordSummary[]> {
    return await this.withIo(id, async () => {
      const stored = await this.requireGenerationRecordNode(id, nodeId);
      const ids = stored.generationRecordIds ?? [];
      const objects = new StoryObjectStore(this.bundlePath(id));
      return await mapWithConcurrency(ids, STORY_LIST_IO_CONCURRENCY, async (recordId) => {
        const record = await objects.readGenerationRecord(recordId);
        return {
          id: recordId,
          kind: record.kind,
          createdAt: record.createdAt,
          ...(record.range === undefined ? {} : { range: record.range })
        };
      });
    });
  }

  /** One Generation Record, fetched on demand — never carried with the
   *  story. 404s distinctly for an unknown take versus a take with no
   *  matching record, and refuses an id that is not actually this node's own
   *  so a stale or guessed id from another node can never be read through
   *  the wrong take's route. Resolved: every source part's prose is read
   *  back from its exact historical revision, not left as a bare reference
   *  the caller has no other way to open — see
   *  server/generation-record-resolve.ts. */
  async loadGenerationRecord(id: string, nodeId: string, recordId: string): Promise<ResolvedGenerationRecord> {
    return await this.withIo(id, async () => {
      const stored = await this.requireGenerationRecordNode(id, nodeId);
      if (!(stored.generationRecordIds ?? []).includes(recordId)) {
        throw new HttpError(404, "This take has no such Generation Record.");
      }
      const objects = new StoryObjectStore(this.bundlePath(id));
      const record = await objects.readGenerationRecord(recordId);
      return await resolveGenerationRecord(record, objects);
    });
  }

  private async requireGenerationRecordNode(id: string, nodeId: string): Promise<StoredNodeV1> {
    let slot: ResolvedStory;
    try {
      slot = await this.resolveUnlocked(id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw new HttpError(404, `Take not found: ${nodeId}`);
      throw error;
    }
    await this.schedulePendingCleanup(id);
    if (slot.kind === "legacy") throw new HttpError(404, `Take not found: ${nodeId}`);
    const manifest = slot.kind === "v5" ? slot.manifest : slot.manifest.content;
    const stored = manifest.nodes.find((node) => node.id === nodeId);
    if (stored === undefined) throw new HttpError(404, `Take not found: ${nodeId}`);
    return stored;
  }

  /** Every part's text, not only the reading line. Search is the one reader
   *  that must see the takes nobody is standing on. */
  async loadHydrated(id: string): Promise<Story> {
    return await this.withIo(id, async () => {
      const story = await this.loadUnlocked(id);
      await hydrateStoryNodes(story, story.nodes.map((node) => node.id));
      await this.schedulePendingCleanup(id);
      return story;
    });
  }

  async create(title: string, requestedId?: string): Promise<Story> {
    if (requestedId !== undefined) {
      try {
        return await this.loadForMutation(requestedId);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) throw error;
      }
    }
    const now = new Date().toISOString();
    const story: Story = {
      id: requestedId ?? randomUUID(), title, createdAt: now, updatedAt: now,
      nodes: [], activeRootId: null, tags: [], recentNodeIds: [], facts: [], chapterBreaks: []
    };
    await this.save(story);
    return story;
  }

  async save(story: Story): Promise<void> {
    await this.withIo(story.id, () => this.saveUnlocked(story, true));
  }

  async remove(id: string): Promise<void> {
    await this.withIo(id, async () => {
      const slot = await readStoredStorySlot(this.dir, id);
      requireMutableStorySlot(slot, id);
      if (slot.kind === "absent") throw new HttpError(404, `Story not found: ${id}`);
      const resolved = slot;
      await this.hydrateResolved(resolved);
      if (resolved.kind === "v5") {
        const duplicate = await this.removeVerifiedLegacyDuplicate(id);
        if (duplicate !== null) requireDurableCommit(duplicate, `Removing legacy duplicate ${id}`);
        requireDurableCommit(await unpublishBundle(this.dir, id), `Deleting story ${id}`);
      } else {
        requireDurableCommit(await unlinkDurable(this.legacyPath(id)), `Deleting legacy story ${id}`);
      }
      this.generationRecordGraphs.delete(id);
    });
  }

  private async loadUnlocked(id: string): Promise<Story> {
    return await this.hydrateResolved(await this.resolveUnlocked(id));
  }

  private async resolveUnlocked(id: string): Promise<ResolvedStory> {
    validateId(id);
    const slot = await readStoredStorySlot(this.dir, id);
    if (slot.kind === "residue") {
      throw new HttpError(409, `Story ${id} has an unfinished storage transition`, "resource_busy");
    }
    if (slot.kind === "absent" || slot.kind === "v6-deleted") {
      throw new HttpError(404, `Story not found: ${id}`);
    }
    return slot;
  }

  private async hydrateResolved(resolved: ResolvedStory): Promise<Story> {
    if (resolved.kind === "legacy") return resolved.story;
    const manifest = resolved.kind === "v5" ? resolved.manifest : resolved.manifest.content;
    return await this.hydrateManifest(manifest, this.bundlePath(manifest.id));
  }

  private async hydrateMutableSlot(slot: MutableStorySlot, id: string): Promise<Story> {
    if (slot.kind === "absent") throw new HttpError(404, `Story not found: ${id}`);
    return await this.hydrateResolved(slot);
  }

  private async saveUnlocked(story: Story, touchUpdatedAt: boolean, reuseFrom?: StoryObjectStore): Promise<void> {
    validateId(story.id);
    const slot = await readStoredStorySlot(this.dir, story.id);
    requireMutableStorySlot(slot, story.id);
    if (touchUpdatedAt) {
      const previous = Date.parse(story.updatedAt);
      story.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    }
    if (slot.kind === "v5") {
      const { manifest: current, sourceSchemaVersion } = slot;
      const previousLive = liveObjectIds(current);
      const cleanup = await StoryCleanupIntent.begin(this.bundlePath(story.id), story.id);
      const duplicate = await this.removeVerifiedLegacyDuplicate(story.id);
      if (duplicate !== null) requireDurableCommit(duplicate, `Removing legacy duplicate ${story.id}`);
      // Durable recovery intent must precede immutable object publication by encode.
      await cleanup.publish();
      try {
        const objects = new StoryObjectStore(this.bundlePath(story.id));
        const candidate = this.snapshots.get(story);
        const snapshot = candidate !== undefined && isCurrentSnapshot(candidate, current) ? candidate : undefined;
        if (snapshot !== undefined) {
          objects.adoptKnownGraph(snapshot.revisions, { committed: true });
          objects.adoptCommittedIds("probabilities", [...snapshot.probabilityIds]);
        }
        const previousGenerationRecordGraph = this.generationRecordGraphs.get(story.id);
        if (previousGenerationRecordGraph?.manifestHash === hashStoryV5ManifestBytes(slot.manifestBytes)) {
          objects.adoptKnownGenerationRecordGraph(previousGenerationRecordGraph.sourceRevisions, { committed: true });
        }
        const manifest = await encodeStoryBundle(story, objects, reuseFrom, snapshot);
        const nextLive = liveObjectIds(manifest);
        const nextRevisionIds = new Set(nextLive.revisions);
        const nextProbabilityIds = new Set(nextLive.probabilities);
        const nextGenerationRecordIds = new Set(nextLive.generationRecords);
        // V2 temporal facts normalize to only their selected revision. Force the
        // first V4 sweep so older state objects that normalization hid are reaped.
        // A dropped node's revision can still be live through a surviving node
        // that shares its text, so the revision check alone misses a dropped
        // node's own Generation Record — check that set too.
        const settled = await cleanup.settle(
          sourceSchemaVersion !== STORY_SCHEMA_VERSION
            || previousLive.revisions.some((revisionId) => !nextRevisionIds.has(revisionId))
            || previousLive.probabilities.some((id) => !nextProbabilityIds.has(id))
            || previousLive.generationRecords.some((id) => !nextGenerationRecordIds.has(id))
        );
        await objects.flush();
        await objects.verifyGraph(nextLive);
        const commit = await this.writeManifest(this.manifestPath(story.id), serializeManifest(manifest));
        this.snapshots.set(story, captureStorySnapshot(story, manifest, objects.verifiedRevisionGraph()));
        requireDurableCommit(commit, `Saving story ${story.id}`);
        this.generationRecordGraphs.set(story.id, generationRecordGraphSnapshot(
          hashStoryV5ManifestBytes(Buffer.from(serializeManifest(manifest), "utf8")),
          nextGenerationRecordIds,
          objects.verifiedGenerationRecordGraph()
        ));
        if (settled === "sweep-owed") {
          this.cleanupQueue.schedule(story.id);
        } else {
          let cleared = false;
          await afterCommit(`clearing additive-save recovery for story ${story.id}`, async () => {
            await clearCleanupPending(this.bundlePath(story.id), story.id);
            cleared = true;
          });
          if (!cleared) this.cleanupQueue.schedule(story.id);
        }
      } catch (error) {
        this.cleanupQueue.schedule(story.id);
        throw error;
      }
      return;
    }
    const legacyBytes = slot.kind === "legacy" ? slot.raw : null;
    const published = await this.publishNewBundle(story, legacyBytes, reuseFrom);
    this.snapshots.set(story, captureStorySnapshot(
      story,
      published.manifest,
      published.objects.verifiedRevisionGraph()
    ));
    requireDurableCommit(published.commit, `Publishing story ${story.id}`);
    const publishedLive = liveObjectIds(published.manifest);
    this.generationRecordGraphs.set(story.id, generationRecordGraphSnapshot(
      hashStoryV5ManifestBytes(Buffer.from(serializeManifest(published.manifest), "utf8")),
      new Set(publishedLive.generationRecords),
      published.objects.verifiedGenerationRecordGraph()
    ));
    if (legacyBytes !== null) await afterCommit(`removing migrated legacy file for story ${story.id}`, async () => {
      const duplicate = await this.removeVerifiedLegacyDuplicate(story.id);
      if (duplicate !== null) requireDurableCommit(duplicate, `Removing migrated legacy story ${story.id}`);
    });
  }

  private async publishNewBundle(
    story: Story,
    legacyBytes: Buffer | null,
    reuseFrom?: StoryObjectStore
  ): Promise<{ commit: CommitResult; manifest: StoryManifestV5; objects: StoryObjectStore }> {
    const temp = stagingBundlePath(this.dir, story.id);
    try {
      const objects = new StoryObjectStore(temp);
      await objects.init();
      if (legacyBytes !== null) {
        const backupDir = path.join(temp, "legacy");
        await mkdir(backupDir, { recursive: true });
        await writeDurableFile(path.join(backupDir, "v1.json"), legacyBytes);
      }
      const manifest = await encodeStoryBundle(story, objects, reuseFrom);
      const raw = serializeManifest(manifest);
      await objects.flush();
      requireDurableCommit(await writeDurableAtomic(path.join(temp, "manifest.json"), raw), `Staging story ${story.id}`);
      await this.hydrateManifest(parseManifest(raw, story.id), temp);
      return { commit: await publishBundle(temp, this.dir, story.id), manifest, objects };
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async hydrateManifest(manifest: StoryManifestV5, bundleDir: string): Promise<Story> {
    const decoded = await decodeStoryBundle(manifest, bundleDir, { activeOnly: true });
    this.snapshots.set(decoded.story, captureStorySnapshot(decoded.story, manifest, decoded.liveRevisions));
    return decoded.story;
  }

  private async removeVerifiedLegacyDuplicate(id: string): Promise<CommitResult | null> {
    const [root, backup] = await Promise.all([
      readOptionalStoryFile(this.legacyPath(id)),
      readOptionalStoryFile(path.join(this.bundlePath(id), "legacy", "v1.json"))
    ]);
    if (root === null) return null;
    if (backup === null) throw new StoryFormatError(`Legacy file remains without a migration backup: ${id}`);
    if (!root.equals(backup)) throw new StoryFormatError(`Conflicting legacy file remains for story: ${id}`);
    return await unlinkDurable(this.legacyPath(id));
  }

  protected async withIo<T>(id: string, work: () => Promise<T>, maintenance = false): Promise<T> {
    validateId(id);
    // Foreground work has priority. Sweep cancellation is cooperative at
    // bounded file operations, so a request never waits for a full-tree pass.
    if (!maintenance) this.cleanupQueue.interrupt(id);
    return await this.ioQueue.run(id, work);
  }

  private async runCleanup(id: string, signal: AbortSignal): Promise<void> {
    // Sharing the queue prevents a sweep from racing object publication. Any
    // foreground enqueue aborts this pass and schedules a safe retry behind it.
    await this.withIo(id, async () => {
      if (signal.aborted) return;
      const slot = await readStoredStorySlot(this.dir, id);
      await afterCommit(`cleaning old objects for story ${id}`, async () => {
        if (!await cleanupPending(this.bundlePath(id))) return;
        // A single `live` value, not two independently-nullable ones: the two
        // used to be computed by identical-shaped ternaries, which meant one
        // could in principle end up null while the other did not — a branch
        // that could never actually fire, since both tested the same
        // `slot.kind`, but only by review discipline rather than by
        // construction. Deriving both from one manifest (or one explicit
        // empty-live case) makes that impossible instead of merely unlikely.
        const content = manifestContentFromSlot(slot);
        const live: LiveStoryObjectIds | null = content !== null
          ? liveObjectIds(content)
          : slot.kind === "v6-deleted"
            ? { revisions: [], probabilities: [], generationRecords: [] }
            : null;
        if (live === null) return;
        const pinned = this.providerSnapshotPins.get(id);
        const beganWithPins = pinned !== undefined;
        const protectedIds: LiveStoryObjectIds = pinned === undefined
          ? live
          : {
              revisions: [...new Set([...live.revisions, ...pinned.revisions.keys()])],
              probabilities: [...new Set([...live.probabilities, ...pinned.probabilities.keys()])],
              generationRecords: live.generationRecords
            };
        const completed = await this.sweep(this.bundlePath(id), protectedIds, signal);
        if (completed
          && !beganWithPins
          && !this.providerSnapshotPins.has(id)) {
          await clearCleanupPending(this.bundlePath(id), id);
        }
      });
    }, true);
  }

  private legacyPath(id: string): string { validateId(id); return path.join(this.dir, `${id}.json`); }
  private bundlePath(id: string): string { validateId(id); return path.join(this.dir, id); }
  private manifestPath(id: string): string { return path.join(this.bundlePath(id), "manifest.json"); }
}

function validateId(id: string): void { if (!isValidId(id)) throw new HttpError(400, "Invalid story id"); }
function isValidId(id: string): boolean { return isStoryId(id); }

function addPins(pins: Map<ObjectHash, number>, ids: readonly ObjectHash[]): void {
  for (const id of ids) pins.set(id, (pins.get(id) ?? 0) + 1);
}

function releasePins(pins: Map<ObjectHash, number>, ids: readonly ObjectHash[]): void {
  for (const id of ids) {
    const count = pins.get(id);
    if (count === undefined || count <= 1) pins.delete(id);
    else pins.set(id, count - 1);
  }
}

function generationRecordGraphSnapshot(
  manifestHash: string,
  liveIds: ReadonlySet<ObjectHash>,
  verified: ReadonlyMap<ObjectHash, readonly ObjectHash[]>
): GenerationRecordSourceRevisionSnapshot {
  return {
    manifestHash,
    sourceRevisions: new Map([...verified].filter(([id]) => liveIds.has(id)))
  };
}

function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }

/** The live V5 content a slot carries, discriminated on `slot.kind` exactly
 *  once — a legacy or V6-deleted slot has none. */
function manifestContentFromSlot(slot: StoredStorySlot): StoryManifestV5 | null {
  if (slot.kind === "v5") return slot.manifest;
  if (slot.kind === "v6-live") return slot.manifest.content;
  return null;
}

function aggregateVersionFromSlot(
  slot: Extract<StoredStorySlot, { kind: "v5" | "v6-live" | "v6-deleted" }>
): StoryAggregateVersion {
  return slot.kind === "v5"
    ? { kind: "v5", manifestHash: hashStoryV5ManifestBytes(slot.manifestBytes) }
    : { kind: "v6", revision: slot.manifest.revision };
}
