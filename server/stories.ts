import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { activeLineFingerprintSource } from "../shared/story-text.js";
import { activePath, pathTo } from "../shared/story-tree.js";
import {
  type EditNodeRequest,
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
  manifestRevisionIds,
  manifestTokenProbabilityIds,
  parseManifest,
  serializeManifest,
  sha256,
  type ObjectHash,
  type StoryManifestV5
} from "./story-format.js";
import type { TokenProbabilityRecord } from "../shared/token-probabilities.js";
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
  createTake,
  createTakeFromCut as createCutTake,
  deleteSubtree,
  newNode,
  pruneUnusedTakes as pruneUnusedStoryTakes,
  requireNode,
  switchLine as switchTreeLine
} from "./story-nodes.js";
import { StoryObjectStore, type LiveStoryObjectIds } from "./story-objects.js";
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

export const STORY_LIST_IO_CONCURRENCY = 4;
export const STORY_UNCHANGED = Symbol("story-unchanged");

type ResolvedStory = Extract<StoredStorySlot, { kind: "legacy" | "v5" | "v6-live" }>;
type SweepObjects = (bundleDir: string, live: LiveStoryObjectIds, signal: AbortSignal) => Promise<boolean>;
type WriteManifest = (file: string, data: string) => Promise<CommitResult>;
interface SwitchLineOptions { expectedLineFingerprint?: string; stopAtNode?: boolean }
/** One story's provider-snapshot pins, kept apart by object kind — mixing
 * them would protect a revision hash from the probabilities sweep pass (or
 * vice versa), silently defeating the pin. */
interface ProviderSnapshotPins {
  readonly revisions: Map<ObjectHash, number>;
  readonly probabilities: Map<ObjectHash, number>;
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
    const revisionIds = [
      ...new Set(manifestRevisionIds(manifest.content))
    ];
    const probabilityIds = [
      ...new Set(manifestTokenProbabilityIds(manifest.content))
    ];
    const pins = this.providerSnapshotPins.get(storyId)
      ?? { revisions: new Map<ObjectHash, number>(), probabilities: new Map<ObjectHash, number>() };
    this.providerSnapshotPins.set(storyId, pins);
    addPins(pins.revisions, revisionIds);
    addPins(pins.probabilities, probabilityIds);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releasePins(pins.revisions, revisionIds);
      releasePins(pins.probabilities, probabilityIds);
      if (pins.revisions.size === 0 && pins.probabilities.size === 0) {
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
      const previousRevisionIds = manifestRevisionIds(current);
      const previousProbabilityIds = manifestTokenProbabilityIds(current);
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
          objects.adoptCommittedProbabilityIds([...snapshot.probabilityIds]);
        }
        const manifest = await encodeStoryBundle(story, objects, reuseFrom, snapshot);
        const nextRevisionIds = new Set(manifestRevisionIds(manifest));
        const nextProbabilityIds = new Set(manifestTokenProbabilityIds(manifest));
        // V2 temporal facts normalize to only their selected revision. Force the
        // first V4 sweep so older state objects that normalization hid are reaped.
        const settled = await cleanup.settle(
          sourceSchemaVersion !== STORY_SCHEMA_VERSION
            || previousRevisionIds.some((revisionId) => !nextRevisionIds.has(revisionId))
            || previousProbabilityIds.some((id) => !nextProbabilityIds.has(id))
        );
        await objects.flush();
        await objects.verifyGraph({
          revisions: manifestRevisionIds(manifest),
          probabilities: manifestTokenProbabilityIds(manifest)
        });
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
        const liveRevisionIds = slot.kind === "v5"
          ? manifestRevisionIds(slot.manifest)
          : slot.kind === "v6-live"
            ? manifestRevisionIds(slot.manifest.content)
          : slot.kind === "v6-deleted"
            ? []
            : null;
        const liveProbabilityIds = slot.kind === "v5"
          ? manifestTokenProbabilityIds(slot.manifest)
          : slot.kind === "v6-live"
            ? manifestTokenProbabilityIds(slot.manifest.content)
          : slot.kind === "v6-deleted"
            ? []
            : null;
        if (liveRevisionIds === null || liveProbabilityIds === null) return;
        const pinned = this.providerSnapshotPins.get(id);
        const beganWithPins = pinned !== undefined;
        const protectedRevisionIds = pinned === undefined
          ? liveRevisionIds
          : [...new Set([...liveRevisionIds, ...pinned.revisions.keys()])];
        const protectedProbabilityIds = pinned === undefined
          ? liveProbabilityIds
          : [...new Set([...liveProbabilityIds, ...pinned.probabilities.keys()])];
        const completed = await this.sweep(
          this.bundlePath(id),
          { revisions: protectedRevisionIds, probabilities: protectedProbabilityIds },
          signal
        );
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

function isErrorCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }

function aggregateVersionFromSlot(
  slot: Extract<StoredStorySlot, { kind: "v5" | "v6-live" | "v6-deleted" }>
): StoryAggregateVersion {
  return slot.kind === "v5"
    ? { kind: "v5", manifestHash: hashStoryV5ManifestBytes(slot.manifestBytes) }
    : { kind: "v6", revision: slot.manifest.revision };
}
