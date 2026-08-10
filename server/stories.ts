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
  type StoryManifestV5,
  type StoryManifestV7
} from "./story-format.js";
import type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
import type { ReasoningRecord } from "../shared/reasoning.js";
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
import {
  LEAF_OBJECT_KINDS,
  StoryObjectStore,
  type LeafObjectKind,
  type LiveStoryObjectIds,
  type ObjectKind
} from "./story-objects.js";
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
  StoryAggregateSession
} from "./story-aggregate-session.js";
import {
  createDraftImageLeaseId,
  createDraftImageLeaseRecord,
  listDraftImageLeases,
  publishDraftImageLease,
  readDraftImageLease,
  removeDraftImageLease,
  type DraftImageLeaseRecord
} from "./story-image-lease.js";
import {
  createStoryImageAttachment,
  DRAFT_IMAGE_LEASE_LIFETIME_MS,
  isDraftImageLeaseId,
  MAX_PROJECT_DRAFT_IMAGE_BYTES,
  MAX_PROJECT_DRAFT_IMAGE_LEASES,
  MAX_STORY_DRAFT_IMAGE_BYTES,
  MAX_STORY_DRAFT_IMAGE_LEASES,
  type DraftImageReference,
  type StoryImageAttachment
} from "../shared/image-attachment.js";
import type { NormalizedImage } from "./image-normalize.js";

export const STORY_LIST_IO_CONCURRENCY = 4;
export const STORY_UNCHANGED = Symbol("story-unchanged");

type ResolvedStory = Extract<StoredStorySlot, { kind: "legacy" | "v5" | "v6-live" | "v8-live" }>;
type SweepObjects = (
  bundleDir: string,
  live: LiveStoryObjectIds,
  signal: AbortSignal,
  liveImageIds?: readonly ObjectHash[]
) => Promise<boolean>;
type WriteManifest = (file: string, data: string) => Promise<CommitResult>;
interface SwitchLineOptions { expectedLineFingerprint?: string; stopAtNode?: boolean }
/** One story's provider-snapshot pins, kept apart by object kind — mixing
 * them would protect a revision hash from the probabilities sweep pass (or
 * vice versa), silently defeating the pin. Shaped like StoryObjectStore's own
 * per-kind collections (server/story-objects.ts) for the same reason: only
 * `revisions` and the `LEAF_OBJECT_KINDS` are ever populated
 * (`LiveStoryObjectIds` has no `chunks`), but sharing the kind-generic shape
 * lets `addLivePins` and `releaseLivePins` below run as one loop each instead
 * of one call per kind. */
type ProviderSnapshotPins = Record<ObjectKind, Map<ObjectHash, number>>;

function emptyProviderSnapshotPins(): ProviderSnapshotPins {
  return {
    chunks: new Map(),
    revisions: new Map(),
    probabilities: new Map(),
    reasoning: new Map(),
    images: new Map()
  };
}

/** Deduplicated per-kind copy of one `LiveStoryObjectIds`, taken once so a
 * pin's later release matches the exact ids it added (`pinProviderSnapshot`
 * below), never a freshly recomputed live set. */
function dedupeLiveObjectIds(live: LiveStoryObjectIds): LiveStoryObjectIds {
  const leaves = {} as Record<LeafObjectKind, readonly ObjectHash[]>;
  for (const kind of LEAF_OBJECT_KINDS) leaves[kind] = [...new Set(live.leaves[kind])];
  return { revisions: [...new Set(live.revisions)], leaves };
}

function addLivePins(pins: ProviderSnapshotPins, live: LiveStoryObjectIds): void {
  addPins(pins.revisions, live.revisions);
  for (const kind of LEAF_OBJECT_KINDS) addPins(pins[kind], live.leaves[kind]);
}

function releaseLivePins(pins: ProviderSnapshotPins, live: LiveStoryObjectIds): void {
  releasePins(pins.revisions, live.revisions);
  for (const kind of LEAF_OBJECT_KINDS) releasePins(pins[kind], live.leaves[kind]);
}

/** The union a sweep must protect: everything live, plus everything a
 * provider snapshot still has pinned (`runCleanup` below). */
function unionLiveWithPins(live: LiveStoryObjectIds, pinned: ProviderSnapshotPins): LiveStoryObjectIds {
  const leaves = {} as Record<LeafObjectKind, readonly ObjectHash[]>;
  for (const kind of LEAF_OBJECT_KINDS) {
    leaves[kind] = [...new Set([...live.leaves[kind], ...pinned[kind].keys()])];
  }
  return {
    revisions: [...new Set([...live.revisions, ...pinned.revisions.keys()])],
    leaves
  };
}

const sweepObjects: SweepObjects = async (bundleDir, live, signal, liveImageIds = []) =>
  await new StoryObjectStore(bundleDir).sweep(live, signal, liveImageIds);

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
      const session = new StoryAggregateSession(this.dir, id, slot);
      await session.init();
      const result = await work(session);
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
      const session = new StoryAggregateSession(this.dir, id, slot);
      await session.init();
      const result = await work(session);
      await this.schedulePendingCleanup(id);
      return result;
    }));
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
   */
  async stageImage(
    storyId: string,
    image: NormalizedImage
  ): Promise<{ leaseId: string; attachment: StoryImageAttachment }> {
    return await this.withIo(storyId, async () => {
      await this.requireStageableStory(storyId);
      const bundleDir = this.bundlePath(storyId);
      const bytes = Buffer.from(image.bytes);
      const attachment = createStoryImageAttachment({
        objectId: sha256(bytes),
        mediaType: image.mediaType,
        width: image.width,
        height: image.height,
        byteLength: bytes.byteLength
      });
      await this.enforceDraftImageQuotas(storyId, attachment);
      const cleanup = await StoryCleanupIntent.begin(bundleDir, storyId);
      const objects = new StoryObjectStore(bundleDir, {
        // Recovery intent precedes the first Image Object byte, exactly like
        // every other object write in this store.
        beforeFirstWrite: () => cleanup.publish()
      });
      await objects.storeImage(bytes);
      await objects.flush();
      const now = Date.now();
      const record = createDraftImageLeaseRecord({
        leaseId: createDraftImageLeaseId(),
        attachment,
        createdAt: now,
        expiresAt: now + DRAFT_IMAGE_LEASE_LIFETIME_MS
      });
      await publishDraftImageLease(bundleDir, record);
      // The lease is the durable protection for the object just written; a
      // later cleanup pass (server/stories.ts's `runCleanup`) rediscovers it
      // from disk and keeps the object alive for as long as the lease is
      // live. Nothing here retires the marker `cleanup.publish()` set.
      this.cleanupQueue.schedule(storyId);
      return { leaseId: record.leaseId, attachment };
    });
  }

  /** Idempotently remove one Draft Lease. Releasing an absent, already
   *  released, or already expired lease succeeds with no error — the design
   *  the DELETE route depends on for its "no content" response. A malformed
   *  id (never sent by a client that only ever echoes an id this store
   *  minted) is a client error, not the internal failure a bare
   *  `StoryFormatError` from the path resolver would otherwise surface as. */
  async releaseImage(storyId: string, leaseId: string): Promise<void> {
    if (!isDraftImageLeaseId(leaseId)) {
      throw new HttpError(400, "Invalid Draft Lease id", "invalid_request");
    }
    await this.withIo(storyId, async () => {
      await removeDraftImageLease(this.bundlePath(storyId), leaseId);
      this.cleanupQueue.schedule(storyId);
    });
  }

  /**
   * Validate one Draft Image reference from a `continueStory` request and
   * durably refresh its Draft Lease to the full lifetime. The rollout plan
   * requires this: "at generation admission, durably refresh each consumed
   * lease for the full lifetime", so a Draft Lease never expires out from
   * under a generation already admitted to use it. Runs in one story
   * `ioQueue` turn, the same turn staging itself uses.
   *
   * Refuses with `image_attachment_expired` when the lease is absent,
   * already expired, or names a different Image Object than the reference
   * claims. The client sends both halves precisely so this mismatch can be
   * caught before any object byte is read.
   */
  async resolveDraftImage(storyId: string, reference: DraftImageReference): Promise<StoryImageAttachment> {
    return await this.withIo(storyId, async () => {
      const bundleDir = this.bundlePath(storyId);
      const now = Date.now();
      const lease = await readDraftImageLease(bundleDir, reference.leaseId);
      if (lease === null || lease.expiresAt <= now || lease.objectId !== reference.objectId) {
        throw expiredAttachment();
      }
      const attachment: StoryImageAttachment = {
        objectId: lease.objectId,
        mediaType: lease.mediaType,
        width: lease.width,
        height: lease.height,
        byteLength: lease.byteLength
      };
      // Refresh by remove-then-republish under the same leaseId: both
      // `story-image-lease.ts` primitives are already crash-safe on their
      // own, and every lease mutation for this story already serializes
      // through this same `ioQueue` turn, so no concurrent writer can ever
      // observe the file absent between the two steps.
      await removeDraftImageLease(bundleDir, lease.leaseId);
      await publishDraftImageLease(bundleDir, createDraftImageLeaseRecord({
        leaseId: lease.leaseId,
        attachment,
        createdAt: now,
        expiresAt: now + DRAFT_IMAGE_LEASE_LIFETIME_MS
      }));
      return attachment;
    });
  }

  /** Read one Image Object's bytes, hash-verified like every other object
   *  read (`StoryObjectStore.readObject`). Callers must load bytes only
   *  after local admission passes, never earlier, so a refused request
   *  never reads a byte it will not send. */
  async loadImage(storyId: string, objectId: string): Promise<Buffer> {
    return await this.withIo(storyId, async () =>
      await new StoryObjectStore(this.bundlePath(storyId)).readImage(objectId));
  }

  /** Remove every Draft Lease a commit consumed, once the manifest and
   *  receipt that consumed it are durable, never before. Idempotent per
   *  lease: an absent lease (already removed by a previous attempt, or
   *  never staged by this process) is success, matching `releaseImage`. */
  async consumeDraftLeases(storyId: string, leaseIds: readonly string[]): Promise<void> {
    if (leaseIds.length === 0) return;
    await this.withIo(storyId, async () => {
      for (const leaseId of leaseIds) await removeDraftImageLease(this.bundlePath(storyId), leaseId);
      this.cleanupQueue.schedule(storyId);
    });
  }

  /** Staging works for any story a reader can already load — including a
   *  successor-schema story a V5 mutation cannot touch — because it never
   *  writes the manifest. Only "does this story exist and does it have a
   *  stable identity" matters here. */
  private async requireStageableStory(storyId: string): Promise<void> {
    const slot = await readStoredStorySlot(this.dir, storyId);
    if (slot.kind === "absent" || slot.kind === "v6-deleted" || slot.kind === "v8-deleted") {
      throw new HttpError(404, `Story not found: ${storyId}`);
    }
    if (slot.kind === "residue") {
      throw new HttpError(409, `Story ${storyId} has an unfinished storage transition`, "resource_busy");
    }
  }

  /**
   * Enforce the story and project Draft Image quotas from the rollout plan,
   * atomically with respect to every other stage or release: the caller
   * already holds the process-wide image permit, which admits only one
   * active stage at a time, so no concurrent stage can observe or create a
   * different quota state while this runs. A concurrent release or cleanup
   * sweep can only shrink the counted totals, never grow them, so a race
   * with either can only make this check MORE permissive than a fully
   * serialized one, never less safe.
   *
   * Expired leases are excluded from every count. The story's own expired
   * leases are removed here, since this call already holds that story's
   * `ioQueue` turn; another story's expired leases are simply not counted,
   * and are reaped by that story's own cleanup pass instead.
   */
  private async enforceDraftImageQuotas(
    storyId: string,
    candidate: StoryImageAttachment
  ): Promise<void> {
    const now = Date.now();
    const storyLeases = await this.liveLeasesRemovingExpired(storyId, now);
    if (storyLeases.length + 1 > MAX_STORY_DRAFT_IMAGE_LEASES) {
      throw quotaExceeded();
    }
    const storyBytes = storyLeases.reduce((sum, lease) => sum + lease.byteLength, 0)
      + candidate.byteLength;
    if (storyBytes > MAX_STORY_DRAFT_IMAGE_BYTES) {
      throw quotaExceeded();
    }

    const allStoryIds = await catalogStoryIds(this.dir);
    let projectLeaseCount = 1; // The lease this call is about to publish.
    const uniqueObjectBytes = new Map<string, number>([[candidate.objectId, candidate.byteLength]]);
    for (const otherId of allStoryIds) {
      const leases = otherId === storyId
        ? storyLeases
        : (await listDraftImageLeases(this.bundlePath(otherId))).filter((lease) => lease.expiresAt > now);
      projectLeaseCount += leases.length;
      for (const lease of leases) uniqueObjectBytes.set(lease.objectId, lease.byteLength);
    }
    if (projectLeaseCount > MAX_PROJECT_DRAFT_IMAGE_LEASES) {
      throw quotaExceeded();
    }
    let projectBytes = 0;
    for (const bytes of uniqueObjectBytes.values()) projectBytes += bytes;
    if (projectBytes > MAX_PROJECT_DRAFT_IMAGE_BYTES) {
      throw quotaExceeded();
    }
  }

  /** This story's live Draft Leases, with every expired lease physically
   *  removed first. Safe to call from inside an already-claimed `ioQueue`
   *  turn for `storyId` — every caller here is. */
  private async liveLeasesRemovingExpired(
    storyId: string,
    now: number
  ): Promise<readonly DraftImageLeaseRecord[]> {
    const bundleDir = this.bundlePath(storyId);
    const leases = await listDraftImageLeases(bundleDir);
    const live: DraftImageLeaseRecord[] = [];
    for (const lease of leases) {
      if (lease.expiresAt <= now) {
        await removeDraftImageLease(bundleDir, lease.leaseId);
      } else {
        live.push(lease);
      }
    }
    return live;
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
        const manifest = await encodeStoryBundle(story, objects, reuseFrom, snapshot);
        const nextLive = liveObjectIds(manifest);
        const nextRevisionIds = new Set(nextLive.revisions);
        const nextLeafIds = {} as Record<LeafObjectKind, Set<ObjectHash>>;
        for (const kind of LEAF_OBJECT_KINDS) nextLeafIds[kind] = new Set(nextLive.leaves[kind]);
        // V2 temporal facts normalize to only their selected revision. Force the
        // first V4 sweep so older state objects that normalization hid are reaped.
        const settled = await cleanup.settle(
          sourceSchemaVersion !== STORY_SCHEMA_VERSION
            || previousLive.revisions.some((revisionId) => !nextRevisionIds.has(revisionId))
            || LEAF_OBJECT_KINDS.some((kind) =>
                previousLive.leaves[kind].some((id) => !nextLeafIds[kind].has(id)))
        );
        await objects.flush();
        await objects.verifyGraph(nextLive);
        const commit = await this.writeManifest(this.manifestPath(story.id), serializeManifest(manifest));
        this.snapshots.set(story, captureStorySnapshot(story, manifest, objects.verifiedRevisionGraph()));
        requireDurableCommit(commit, `Saving story ${story.id}`);
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
    this.snapshots.set(story, captureStorySnapshot(story, published.manifest, published.objects.verifiedRevisionGraph()));
    requireDurableCommit(published.commit, `Publishing story ${story.id}`);
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
        const liveLeases = await this.liveLeasesRemovingExpired(id, Date.now());
        const liveImageIds = liveLeases.map((lease) => lease.objectId);
        const hasLiveLease = liveLeases.length > 0;
        if (!await cleanupPending(bundleDir)) return;
        // A single `live` value, not two independently-nullable ones: the two
        // used to be computed by identical-shaped ternaries, which meant one
        // could in principle end up null while the other did not — a branch
        // that could never actually fire, since both tested the same
        // `slot.kind`, but only by review discipline rather than by
        // construction. Deriving both from one manifest (or one explicit
        // empty-live case) makes that impossible instead of merely unlikely.
        const content = manifestContentFromSlot(slot);
        const live = content !== null
          ? liveObjectIds(content)
          : slot.kind === "v6-deleted"
            ? { revisions: [], leaves: { probabilities: [], reasoning: [], images: [] } }
            : null;
        if (live === null) return;
        const pinned = this.providerSnapshotPins.get(id);
        const beganWithPins = pinned !== undefined;
        const protectedIds: LiveStoryObjectIds = pinned === undefined
          ? live
          : unionLiveWithPins(live, pinned);
        const completed = await this.sweep(bundleDir, protectedIds, signal, liveImageIds);
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

function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }

function quotaExceeded(): HttpError {
  return new HttpError(
    422,
    "Staging this image would exceed a Draft Image quota.",
    "image_draft_quota_exceeded"
  );
}

function expiredAttachment(): HttpError {
  return new HttpError(
    400,
    "This Draft Image is no longer available. Attach the image again.",
    "image_attachment_expired"
  );
}

/** The live V5 content a slot carries, discriminated on `slot.kind` exactly
 *  once — a legacy or V6-deleted slot has none. */
function manifestContentFromSlot(slot: StoredStorySlot): StoryManifestV5 | null {
  if (slot.kind === "v5") return slot.manifest;
  if (slot.kind === "v6-live") return slot.manifest.content;
  return null;
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
