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
import { BoundedLruMap } from "../shared/bounded-lru-map.js";
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
  type StoryManifestV5,
  type StoryManifestV7
} from "./story-format.js";
import type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
import type { GenerationRecordSummary, ResolvedGenerationRecord } from "../shared/generation-record.js";
import { resolveGenerationRecord } from "./generation-record-resolve.js";
import type { ReasoningRecord } from "../shared/reasoning.js";
import { decodeStoryBundle, encodeStoryBundle, hydrateStoryNodes } from "./story-codec.js";
import {
  peekPendingGenerationRecords,
  restorePendingGenerationRecords
} from "./story-node-generation-records.js";
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
import {
  LEAF_OBJECT_KINDS,
  StoryObjectStore,
  type LeafObjectKind,
  type LiveStoryObjectIds
} from "./story-objects.js";
import {
  addLivePins,
  addPins,
  dedupeLiveObjectIds,
  emptyProviderSnapshotPins,
  releaseLivePins,
  releasePins,
  unionLiveWithPins,
  type ProviderSnapshotPins
} from "./story-provider-snapshot-pins.js";
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
  storySlotSweepLiveIds,
  type MutableStorySlot,
  type StoryMetadata,
  type StoredStorySlot
} from "./story-storage-reader.js";
import { buildStorySummary } from "./story-summary.js";
import { storySummaryFromLiveEnvelope } from "./story-v6-codec.js";
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
  stagedStoryManifestExists,
  StoryAggregateSession,
  type GenerationRecordSourceRevisionSnapshot
} from "./story-aggregate-session.js";
import { StoryDraftImageStore } from "./story-draft-images.js";
import type { DraftImageReference, StoryImageAttachment } from "../shared/image-attachment.js";
import type { NormalizedImage } from "./image-normalize.js";
import {
  NO_CHAPTER_BREAK_UNDO_LIVENESS,
  type ChapterBreakUndoLiveness
} from "./chapter-break-undo-liveness.js";

export const STORY_LIST_IO_CONCURRENCY = 4;
export const STORY_UNCHANGED = Symbol("story-unchanged");
/** Save/session optimization only: an evicted story simply re-verifies its
 * Generation Record source-revision graph from disk on its next save. Sized
 * like this codebase's other per-process session bounds (see
 * shared/http-operation-protocol.ts's HTTP_OPERATION_SESSION_CAPACITY). */
export const GENERATION_RECORD_GRAPH_CACHE_CAPACITY = 64;

type ResolvedStory = Extract<StoredStorySlot, { kind: "legacy" | "v5" | "v6-live" | "v8-live" }>;
type SweepObjects = (bundleDir: string, live: LiveStoryObjectIds, signal: AbortSignal) => Promise<boolean>;
type WriteManifest = (file: string, data: string) => Promise<CommitResult>;
interface SwitchLineOptions { expectedLineFingerprint?: string; stopAtNode?: boolean }

const sweepObjects: SweepObjects = async (bundleDir, live, signal) =>
  await new StoryObjectStore(bundleDir).sweep(live, signal);

export class StoryStore {
  constructor(
    private readonly dir: string,
    private readonly sweep: SweepObjects = sweepObjects,
    private readonly writeManifest: WriteManifest = writeDurableAtomic,
    generationRecordGraphCacheCapacity: number = GENERATION_RECORD_GRAPH_CACHE_CAPACITY,
    private readonly liveGenerationRecordIds: ChapterBreakUndoLiveness = NO_CHAPTER_BREAK_UNDO_LIVENESS,
    /** Whether a session this store opens may reopen a successor-schema
     *  story for mutation. Absent resolves through
     *  `resolveImageInputActivation()` (`shared/image-input-release.ts`), so
     *  production wiring stays on the release default. This store owns the
     *  concept: `withAggregateSession` and `withOptionalAggregateSession`
     *  read it directly instead of taking it per call, so every caller that
     *  opens a session over the same store gets the same gate. */
    private readonly imageInputActivation?: boolean
  ) {
    this.cleanupQueue = new BoundedCleanupQueue(
      STORY_CLEANUP_IO_CONCURRENCY,
      (storyId, signal) => this.runCleanup(storyId, signal)
    );
    // The Draft Image lifecycle needs exactly three things this class owns:
    // the storage root, one `ioQueue` turn per story, and a way to schedule
    // that story's next cleanup pass. Handing over those three primitives,
    // rather than `this`, keeps the collaborator's surface honest, it
    // cannot reach into mutation, snapshots, or pins it has no business
    // touching (server/story-draft-images.ts).
    this.draftImages = new StoryDraftImageStore(
      this.dir,
      (id, work) => this.withIo(id, work),
      (id) => this.cleanupQueue.schedule(id)
    );
    this.generationRecordGraphs = new BoundedLruMap(generationRecordGraphCacheCapacity);
  }

  private readonly draftImages: StoryDraftImageStore;
  private readonly snapshots = new WeakMap<Story, StoryRevisionSnapshot>();
  private readonly providerSnapshotPins =
    new Map<string, ProviderSnapshotPins>();
  /** One V6 story's last hash-verified generation record source-revision
   *  graph, keyed by story id since a `StoryAggregateSession` is created
   *  fresh for every `withAggregateSession` call and cannot itself carry
   *  state between them. Guarded at adoption time by the manifest hash it
   *  was captured against (`StoryAggregateSession.capturedGenerationRecordGraph`),
   *  so a stale entry here is simply ignored, never trusted. Bounded: this is
   *  a save/session optimization, not a source of truth, so evicting a cold
   *  story's entry only costs a re-verify on its next save, never
   *  correctness. Capacity is constructor-injectable (default
   *  GENERATION_RECORD_GRAPH_CACHE_CAPACITY) so tests can force eviction
   *  without touching that many stories. */
  private readonly generationRecordGraphs: BoundedLruMap<string, GenerationRecordSourceRevisionSnapshot>;
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
      requirePresentStorySlot(slot, id, this.imageInputActivation);
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
      requirePresentStorySlot(slot, id, this.imageInputActivation);
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
    const dedupedLive = dedupeLiveObjectIds(live);
    const pins = this.providerSnapshotPins.get(storyId) ?? emptyProviderSnapshotPins();
    this.providerSnapshotPins.set(storyId, pins);
    addLivePins(pins, dedupedLive);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseLivePins(pins, dedupedLive);
      if (Object.values(pins).every((map) => map.size === 0)) {
        this.providerSnapshotPins.delete(storyId);
      }
      this.cleanupQueue.schedule(storyId);
    };
  }

  /** Pin Image Object ids that are not yet reachable from any manifest: a
   *  Draft Image a generation admitted, still referenced only by its Draft
   *  Lease. Shares the same per-story pin map `pinProviderSnapshot` uses, so
   *  the sweep protects both kinds of pin together (`unionLiveWithPins`
   *  below). A no-op for an empty list, so a caller with no images to pin
   *  need not branch. */
  pinImages(storyId: string, objectIds: readonly ObjectHash[]): void {
    if (objectIds.length === 0) return;
    const pins = this.providerSnapshotPins.get(storyId) ?? emptyProviderSnapshotPins();
    this.providerSnapshotPins.set(storyId, pins);
    addPins(pins.images, objectIds);
  }

  /** Release exactly the ids a matching `pinImages` call added. Idempotent
   *  and safe to call with an empty list (a no-op), so a caller that never
   *  pinned anything can release unconditionally in a `finally`. */
  releaseImagePins(storyId: string, objectIds: readonly ObjectHash[]): void {
    if (objectIds.length === 0) return;
    const pins = this.providerSnapshotPins.get(storyId);
    if (pins === undefined) return;
    releasePins(pins.images, objectIds);
    if (Object.values(pins).every((map) => map.size === 0)) {
      this.providerSnapshotPins.delete(storyId);
    }
    this.cleanupQueue.schedule(storyId);
  }

  /**
   * Stage one already-normalized Source Image as a Draft Image: store its
   * bytes as a content-addressed Image Object and publish a Draft Lease that
   * keeps it alive. This is NOT a story mutation — it takes no `withLock`
   * turn, no mutation coordinator scope, and writes no manifest. It claims
   * one `ioQueue` turn, the same turn every foreground read and write
   * already shares with the sweep, so a staging write and a sweep can never
   * race each other.
   *
   * The caller must already hold the process-wide image stage permit
   * (server/image-stage-permit.ts) and must have normalized `image` before
   * calling this (server/story-image-stage.ts does both).
   *
   * Thin delegation to `StoryDraftImageStore` (server/story-draft-images.ts),
   * which owns the whole Draft Image lifecycle; see that file for the
   * behavior. This class keeps only `pinImages`/`releaseImagePins` below,
   * because those touch `providerSnapshotPins`, a field this class owns.
   */
  async stageImage(
    storyId: string,
    image: NormalizedImage
  ): Promise<{ leaseId: string; attachment: StoryImageAttachment }> {
    return await this.draftImages.stageImage(storyId, image);
  }

  /** See `StoryDraftImageStore.releaseImage`. */
  async releaseImage(storyId: string, leaseId: string): Promise<void> {
    return await this.draftImages.releaseImage(storyId, leaseId);
  }

  /** See `StoryDraftImageStore.resolveDraftImage`. */
  async resolveDraftImage(storyId: string, reference: DraftImageReference): Promise<StoryImageAttachment> {
    return await this.draftImages.resolveDraftImage(storyId, reference);
  }

  /** See `StoryDraftImageStore.loadImage`. */
  async loadImage(storyId: string, objectId: string): Promise<Buffer> {
    return await this.draftImages.loadImage(storyId, objectId);
  }

  /** See `StoryDraftImageStore.consumeDraftLeases`. */
  async consumeDraftLeases(storyId: string, leaseIds: readonly string[]): Promise<void> {
    return await this.draftImages.consumeDraftLeases(storyId, leaseIds);
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
      if (slot.kind === "v6-live" || slot.kind === "v8-live") return {
        ...storySummaryFromLiveEnvelope(slot.manifest),
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
   *  a bounded set (MAX_GENERATION_RECORD_IDS), never the whole story. The
   *  caller supplies a cancellation signal because a full valid history can
   *  require many object reads. */
  async loadGenerationRecordSummaries(
    id: string,
    nodeId: string,
    signal?: AbortSignal
  ): Promise<GenerationRecordSummary[]> {
    return await this.withIo(id, async () => {
      signal?.throwIfAborted();
      const found = await this.requireGenerationRecordNode(id, nodeId);
      signal?.throwIfAborted();
      if (found.kind === "legacy") return [];
      const ids = found.stored.generationRecordIds ?? [];
      const objects = new StoryObjectStore(this.bundlePath(id));
      const summaries = await mapWithConcurrency(ids, STORY_LIST_IO_CONCURRENCY, async (recordId) => {
        signal?.throwIfAborted();
        const record = await objects.readGenerationRecord(recordId);
        signal?.throwIfAborted();
        return {
          id: recordId,
          kind: record.kind,
          createdAt: record.createdAt,
          ...(record.range === undefined ? {} : { range: record.range })
        };
      });
      signal?.throwIfAborted();
      return summaries;
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
  async loadGenerationRecord(
    id: string,
    nodeId: string,
    recordId: string,
    signal?: AbortSignal
  ): Promise<ResolvedGenerationRecord> {
    return await this.withIo(id, async () => {
      signal?.throwIfAborted();
      const found = await this.requireGenerationRecordNode(id, nodeId);
      signal?.throwIfAborted();
      if (found.kind === "legacy") throw new HttpError(404, `Take not found: ${nodeId}`);
      if (!(found.stored.generationRecordIds ?? []).includes(recordId)) {
        throw new HttpError(404, "This take has no such Generation Record.");
      }
      const objects = new StoryObjectStore(this.bundlePath(id));
      const record = await objects.readGenerationRecord(recordId);
      signal?.throwIfAborted();
      return await resolveGenerationRecord(record, objects, signal);
    });
  }

  /** A legacy story predates Generation Records, so it never has any — its
   *  node either exists (callers treat that as a take with no history) or it
   *  doesn't (still a 404, same as an unknown take in any other format). */
  private async requireGenerationRecordNode(
    id: string,
    nodeId: string
  ): Promise<{ kind: "legacy" } | { kind: "stored"; stored: StoredNodeV1 }> {
    let slot: ResolvedStory;
    try {
      slot = await this.resolveUnlocked(id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw new HttpError(404, `Take not found: ${nodeId}`);
      throw error;
    }
    await this.schedulePendingCleanup(id);
    if (slot.kind === "legacy") {
      if (!slot.story.nodes.some((node) => node.id === nodeId)) {
        throw new HttpError(404, `Take not found: ${nodeId}`);
      }
      return { kind: "legacy" };
    }
    const manifest = slot.kind === "v5" ? slot.manifest : slot.manifest.content;
    const stored = manifest.nodes.find((node) => node.id === nodeId);
    if (stored === undefined) throw new HttpError(404, `Take not found: ${nodeId}`);
    return { kind: "stored", stored };
  }

  /** One take's stored reasoning ("thought"), mirroring
   *  `loadTokenProbabilities` exactly: 404s, distinguishably by message, when
   *  the story, the take, or the take's stored thought is missing. */
  async loadReasoning(id: string, nodeId: string): Promise<ReasoningRecord> {
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
      if (stored.reasoningId === undefined) {
        throw new HttpError(404, "This take has no stored thought.");
      }
      return await new StoryObjectStore(this.bundlePath(id)).readReasoning(stored.reasoningId);
    });
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
    if (slot.kind === "absent" || slot.kind === "v6-deleted" || slot.kind === "v8-deleted") {
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
      // encodeStoryBundle below drains each node's pending Generation Records as
      // soon as its bytes land in this story's live bundle directory — before
      // flush, verifyGraph, and the manifest write below make those bytes
      // reachable from a published manifest. A failure anywhere in between
      // schedules cleanup, which can reap the now-unreferenced object; without
      // this snapshot, a same-story retry would see an empty pending queue and
      // skip re-writing those bytes, publishing a Generation Record id whose
      // object is gone. Mirrors publishNewBundle; see
      // story-node-generation-records.ts.
      const pendingSnapshots = story.nodes
        .map((node) => [node, peekPendingGenerationRecords(node)] as const)
        .filter(([, records]) => records.length > 0);
      let manifestPublished = false;
      try {
        const objects = new StoryObjectStore(this.bundlePath(story.id));
        const candidate = this.snapshots.get(story);
        const snapshot = candidate !== undefined && isCurrentSnapshot(candidate, current) ? candidate : undefined;
        if (snapshot !== undefined) {
          objects.adoptKnownGraph(snapshot.revisions, { committed: true });
          objects.adoptCommittedIds("probabilities", [...snapshot.probabilityIds]);
          objects.adoptCommittedIds("reasoning", [...snapshot.reasoningIds]);
          objects.adoptCommittedIds("images", [...snapshot.imageIds]);
        }
        const previousGenerationRecordGraph = this.generationRecordGraphs.get(story.id);
        if (previousGenerationRecordGraph?.manifestHash === hashStoryV5ManifestBytes(slot.manifestBytes)) {
          objects.adoptKnownGenerationRecordGraph(previousGenerationRecordGraph.sourceRevisions, { committed: true });
        }
        const manifest = await encodeStoryBundle(story, objects, reuseFrom, snapshot);
        const nextLive = liveObjectIds(manifest);
        const nextRevisionIds = new Set(nextLive.revisions);
        const nextLeafIds = {} as Record<LeafObjectKind, Set<ObjectHash>>;
        for (const kind of LEAF_OBJECT_KINDS) nextLeafIds[kind] = new Set(nextLive.leaves[kind]);
        const nextGenerationRecordIds = new Set(nextLive.generationRecords);
        // V2 temporal facts normalize to only their selected revision. Force the
        // first V4 sweep so older state objects that normalization hid are reaped.
        // A dropped node's revision can still be live through a surviving node
        // that shares its text, so the revision check alone misses a dropped
        // node's own Generation Record — check that set too.
        const settled = await cleanup.settle(
          sourceSchemaVersion !== STORY_SCHEMA_VERSION
            || previousLive.revisions.some((revisionId) => !nextRevisionIds.has(revisionId))
            || LEAF_OBJECT_KINDS.some((kind) =>
                previousLive.leaves[kind].some((id) => !nextLeafIds[kind].has(id)))
            || previousLive.generationRecords.some((id) => !nextGenerationRecordIds.has(id))
        );
        await objects.flush();
        await objects.verifyGraph(nextLive);
        const commit = await this.writeManifest(this.manifestPath(story.id), serializeManifest(manifest));
        manifestPublished = true;
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
        if (!manifestPublished) {
          for (const [node, records] of pendingSnapshots) restorePendingGenerationRecords(node, records);
        }
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
  ): Promise<{
    commit: CommitResult;
    manifest: StoryManifestV5 | StoryManifestV7;
    objects: StoryObjectStore;
  }> {
    const temp = stagingBundlePath(this.dir, story.id);
    // encodeStoryBundle below drains each node's pending Generation Records as
    // soon as its bytes land in this *staging* store — but staging is not yet
    // the published bundle. A failure anywhere after that write (including
    // publishBundle's own rename) hits the catch below, which discards the
    // whole staging directory; without this snapshot, a same-story retry
    // would see an empty pending queue and skip re-writing those bytes,
    // publishing a Generation Record id whose object was never durably
    // stored anywhere. See story-node-generation-records.ts.
    const pendingSnapshots = story.nodes
      .map((node) => [node, peekPendingGenerationRecords(node)] as const)
      .filter(([, records]) => records.length > 0);
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
      for (const [node, records] of pendingSnapshots) restorePendingGenerationRecords(node, records);
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async hydrateManifest(manifest: StoryManifestV5 | StoryManifestV7, bundleDir: string): Promise<Story> {
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
        const bundleDir = this.bundlePath(id);
        // Every expired lease is removed up front, before either quota
        // check or sweep can see it, exactly like the rollout plan requires.
        // A remaining live lease protects its Image Object even when the
        // manifest names nothing: the story sweep marks Image Objects from
        // the manifest AND from live Draft Leases.
        const liveLeases = await this.draftImages.liveLeasesRemovingExpired(id, Date.now());
        const liveImageIds = liveLeases.map((lease) => lease.objectId);
        const hasLiveLease = liveLeases.length > 0;
        if (!await cleanupPending(bundleDir)) return;
        // A staged successor can reference objects that the current manifest
        // does not reference. Recovery owns the staged file and schedules a
        // later cleanup after it publishes or discards that file.
        if (await stagedStoryManifestExists(bundleDir)) return;
        // One exhaustive lookup, not a hand-written `if` chain: every kind
        // `storySlotSweepLiveIds` does not explicitly decide for fails to
        // compile there instead of silently sweeping as if nothing were
        // live (server/story-storage-reader.ts). That is stronger than the
        // single-value discipline this block used to rely on, and it is what
        // caught the successor kinds the hand-written chains had missed.
        const live = storySlotSweepLiveIds(slot);
        if (live === null) return;
        const pinned = this.providerSnapshotPins.get(id);
        const undoGenerationRecords = this.liveGenerationRecordIds(id);
        const beganWithPins = pinned !== undefined;
        const liveWithUndo: LiveStoryObjectIds = {
          ...live,
          generationRecords: [...new Set([...live.generationRecords, ...undoGenerationRecords])]
        };
        const protectedIds = unionLiveWithPins(liveWithUndo, pinned ?? emptyProviderSnapshotPins(), liveImageIds);
        const completed = await this.sweep(bundleDir, protectedIds, signal);
        // A live Draft Lease keeps its Image Object marked without ever
        // appearing in the manifest, so the marker must stay even when the
        // sweep otherwise found nothing to retire: the next pass, after the
        // lease expires, is what finally reaps that object.
        if (completed
          && !beganWithPins
          && !this.providerSnapshotPins.has(id)
          && !hasLiveLease) {
          await clearCleanupPending(bundleDir, id);
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

function aggregateVersionFromSlot(
  slot: Extract<StoredStorySlot, { kind: "v5" | "v6-live" | "v6-deleted" | "v8-live" | "v8-deleted" }>
): StoryAggregateVersion {
  // A successor envelope's revision counter is the same concurrency token
  // shape as a V6 envelope's. "v6" here names the token shape (a revision
  // counter, as opposed to "v5"'s manifest hash), not the schema version.
  return slot.kind === "v5"
    ? { kind: "v5", manifestHash: hashStoryV5ManifestBytes(slot.manifestBytes) }
    : { kind: "v6", revision: slot.manifest.revision };
}
