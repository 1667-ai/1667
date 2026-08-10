/**
 * The Draft Image lifecycle: staging a Normalized Image as a content-addressed
 * Image Object plus a Draft Lease, releasing it, resolving and refreshing a
 * lease at generation admission, reading an Image Object's bytes back, and
 * consuming the leases a commit used.
 *
 * Extracted out of `server/stories.ts` (`StoryStore`) because every method
 * here needs exactly three things a story store owns: the storage root, one
 * `ioQueue` turn per story, and a way to schedule that story's next cleanup
 * pass. Handing over those three primitives, rather than the whole store,
 * keeps this collaborator's surface honest, it cannot reach into mutation
 * state, snapshots, or provider-snapshot pins it has no business touching.
 *
 * `enforceDraftImageQuotas` is the clearest sign this belongs apart from
 * `StoryStore`: it walks the whole project catalog and every other story's
 * lease directory to enforce a project-scoped policy, not a per-story one.
 */
import path from "node:path";
import { ServiceError as HttpError } from "./errors.js";
import { sha256 } from "./story-format.js";
import { StoryCleanupIntent } from "./story-cleanup.js";
import { StoryObjectStore } from "./story-objects.js";
import { catalogStoryIds, readStoredStorySlot } from "./story-storage-reader.js";
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
import { isStoryId } from "./story-v5-strict.js";
import type { NormalizedImage } from "./image-normalize.js";

export class StoryDraftImageStore {
  constructor(
    private readonly dir: string,
    private readonly withIo: <T>(id: string, work: () => Promise<T>) => Promise<T>,
    private readonly scheduleCleanup: (id: string) => void
  ) {}

  /**
   * Stage one already-normalized Source Image as a Draft Image: store its
   * bytes as a content-addressed Image Object and publish a Draft Lease that
   * keeps it alive. This is NOT a story mutation, it takes no mutation
   * coordinator scope and writes no manifest. It claims one `ioQueue` turn,
   * the same turn every foreground read and write already shares with the
   * sweep, so a staging write and a sweep can never race each other.
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
      this.scheduleCleanup(storyId);
      return { leaseId: record.leaseId, attachment };
    });
  }

  /** Idempotently remove one Draft Lease. Releasing an absent, already
   *  released, or already expired lease succeeds with no error, the design
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
      this.scheduleCleanup(storyId);
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
      this.scheduleCleanup(storyId);
    });
  }

  /** This story's live Draft Leases, with every expired lease physically
   *  removed first. Safe to call from inside an already-claimed `ioQueue`
   *  turn for `storyId` - every caller here is. Public because
   *  `server/stories.ts`'s `runCleanup` needs it too, to fold a live lease's
   *  Image Object id into the ids one sweep pass must protect. */
  async liveLeasesRemovingExpired(
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

  /** Staging works for any story a reader can already load, including a
   *  successor-schema story a V5 mutation cannot touch, because it never
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

  private bundlePath(id: string): string {
    if (!isStoryId(id)) throw new HttpError(400, "Invalid story id");
    return path.join(this.dir, id);
  }
}

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
