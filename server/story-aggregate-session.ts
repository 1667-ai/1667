import {
  chmod,
  lstat,
  rename
} from "node:fs/promises";
import path from "node:path";
import { activePath } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import { ServiceError } from "./errors.js";
import {
  decodeStoryBundle,
  encodeStoryBundle,
  hydrateStoryNodes
} from "./story-codec.js";
import { pathTo } from "../shared/story-tree.js";
import {
  manifestRevisionIds,
  STORY_SCHEMA_VERSION,
  type ObjectHash,
  type TextRevisionV1
} from "./story-format.js";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile
} from "./private-file-publication.js";
import {
  afterCommit,
  StoryDurabilityError,
  syncDirectory,
} from "./story-lifecycle.js";
import {
  clearCleanupPending,
  StoryCleanupIntent
} from "./story-cleanup.js";
import {
  storyAggregateSnapshot,
  storyProjection,
  type StoryAggregateSnapshot
} from "./story-aggregate-state.js";
import { hashStoryV6ManifestBytes } from "./story-manifest-hash.js";
import type { StoredStorySlot } from "./story-storage-reader.js";
import {
  formatV6,
  MAX_DELETED_STORY_MANIFEST_BYTES,
  parseStoryManifestBytes,
  storySummaryV6FromContent
} from "./story-v6-codec.js";
import type {
  LiveStoryManifestV6,
  StoryManifestV6
} from "./story-v6-types.js";
import { MAX_STORY_MANIFEST_BYTES } from "./story-v5-strict.js";
import { StoryObjectStore } from "./story-objects.js";

const MANIFEST_FILE = "manifest.json";
const NEXT_MANIFEST_FILE = `${MANIFEST_FILE}.next`;
const MANIFEST_POLICY = {
  label: "Story manifest replacement",
  maxBytes: MAX_STORY_MANIFEST_BYTES
} as const;

type PresentStorySlot = Extract<
  StoredStorySlot,
  { kind: "v5" | "v6-live" | "v6-deleted" }
>;

export interface PreparedStoryContent {
  readonly story: Story;
  readonly content: LiveStoryManifestV6["content"];
  readonly summary: LiveStoryManifestV6["summary"];
}

/** One story-scope-held filesystem view. Callers own coordinator admission and
 * the StoryStore's per-story I/O lock for this session's complete lifetime. */
export class StoryAggregateSession {
  private currentSnapshot: StoryAggregateSnapshot;
  private readonly bundleDir: string;
  /** The staged replacement carries its own cleanup verdict, so a manifest
   * recovered from disk can never retire a marker another transaction owes. */
  private staged: {
    readonly manifest: StoryManifestV6;
    readonly clearCleanupOnPublish: boolean;
  } | null = null;
  /** Handed from prepareContent to the stageManifest call that stages its
   * replacement; consumed there. */
  private preparedCleanupRetirement = false;
  /** Revision graph hash-verified while loading the committed manifest that
   * `manifestHash` names. Stale after any snapshot replacement. */
  private liveGraph: {
    readonly manifestHash: string;
    readonly revisions: ReadonlyMap<ObjectHash, TextRevisionV1>;
  } | null = null;

  get snapshot(): StoryAggregateSnapshot {
    return this.currentSnapshot;
  }

  constructor(
    storyRoot: string,
    readonly storyId: string,
    slot: PresentStorySlot
  ) {
    this.bundleDir = path.join(storyRoot, storyId);
    this.currentSnapshot = storyAggregateSnapshot(slot);
  }

  async init(): Promise<void> {
    const before = await lstat(this.bundleDir);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`Story bundle is not a directory: ${this.storyId}`);
    }
    if (process.platform !== "win32") {
      if (typeof process.geteuid === "function" && before.uid !== process.geteuid()) {
        throw new Error(`Story bundle owner is unsafe: ${this.storyId}`);
      }
      // Legacy V5 bundles were created under the caller's umask. Tightening an
      // owned directory is safety maintenance, not an aggregate mutation.
      if ((before.mode & 0o777) !== 0o700) {
        await chmod(this.bundleDir, 0o700);
        await syncDirectory(this.bundleDir);
        await syncDirectory(path.dirname(this.bundleDir));
      }
    }
    await inspectPrivateDirectory(this.bundleDir, MANIFEST_POLICY.label);
  }

  async loadLive(): Promise<Story> {
    if (this.snapshot.manifest.kind !== "live") {
      throw new ServiceError(404, `Story not found: ${this.storyId}`);
    }
    const decoded = await decodeStoryBundle(
      this.snapshot.manifest.content,
      this.bundleDir,
      { activeOnly: true }
    );
    // liveRevisions is a live view: it keeps growing through later
    // hydrations, and every entry was read back and hash-verified against
    // the committed manifest this snapshot names.
    this.liveGraph = {
      manifestHash: this.snapshot.manifestHash,
      revisions: decoded.liveRevisions
    };
    return decoded.story;
  }

  async hydratePath(story: Story, nodeId: string): Promise<void> {
    await hydrateStoryNodes(story, pathTo(story, nodeId).map((node) => node.id));
  }

  async hydrateNodes(story: Story, nodeIds: readonly string[]): Promise<void> {
    await hydrateStoryNodes(story, nodeIds);
  }

  async prepareContent(story: Story): Promise<PreparedStoryContent> {
    if (story.id !== this.storyId) throw new Error("Story mutation changed aggregate identity");
    if (this.snapshot.manifest.kind !== "live") {
      throw new ServiceError(404, `Story not found: ${this.storyId}`);
    }
    this.preparedCleanupRetirement = false;
    const previousRevisionIds = manifestRevisionIds(this.snapshot.manifest.content);
    const previous = Date.parse(story.updatedAt);
    story.updatedAt = new Date(
      Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)
    ).toISOString();
    await hydrateStoryNodes(story, activePath(story).map((node) => node.id));
    const cleanup = await StoryCleanupIntent.begin(this.bundleDir, this.storyId);
    const objects = new StoryObjectStore(this.bundleDir, {
      // Recovery intent precedes immutable-object publication. A failed or
      // committed write can therefore be swept against the authoritative
      // manifest without retaining orphaned revisions indefinitely.
      beforeFirstWrite: () => cleanup.publish()
    });
    if (this.liveGraph !== null && this.liveGraph.manifestHash === this.snapshot.manifestHash) {
      // Trust by induction: every committed manifest passed verifyGraph
      // before it could publish, so the ids it references are durable
      // without re-reading them, and this session's loadLive additionally
      // read and hash-verified the graph it decoded. Objects written by
      // THIS mutation are still read back and hash-verified; pre-existing
      // corruption on inactive branches surfaces at read time instead of
      // blocking unrelated saves.
      objects.adoptKnownGraph(this.liveGraph.revisions, { committed: true });
      objects.adoptCommittedRevisionIds(previousRevisionIds);
    }
    const content = await encodeStoryBundle(story, objects);
    await objects.flush();
    await objects.verifyGraph(manifestRevisionIds(content));
    const nextRevisionIds = new Set(manifestRevisionIds(content));
    // Parsing normalizes V2-V4 sources before this diff can run (old fact
    // states collapse to their selected revision), so objects the
    // normalization dropped never appear in previousRevisionIds. Mirror the
    // V5 save path: a legacy-schema source always owes the first V5 sweep.
    const source = this.snapshot.source;
    const legacySchemaSource = source.kind === "v5"
      && source.sourceSchemaVersion !== STORY_SCHEMA_VERSION;
    this.preparedCleanupRetirement = await cleanup.settle(
      legacySchemaSource
        || previousRevisionIds.some((id) => !nextRevisionIds.has(id))
    ) === "retire-marker";
    return {
      story,
      content,
      summary: storySummaryV6FromContent(content)
    };
  }

  async ensureCleanupPending(): Promise<void> {
    await (await StoryCleanupIntent.begin(this.bundleDir, this.storyId)).publish();
  }

  async readStagedManifest(): Promise<StoryManifestV6 | null> {
    const bytes = await readOptionalPrivateFile(
      this.nextManifestPath(),
      MANIFEST_POLICY
    );
    if (bytes === null) return null;
    const parsed = parseStoryManifestBytes(bytes, this.storyId);
    if (parsed.kind === "v5") {
      throw new Error("Story manifest replacement cannot regress to V5");
    }
    const manifest = parsed.manifest;
    if (manifest.kind === "deleted"
      && bytes.byteLength > MAX_DELETED_STORY_MANIFEST_BYTES) {
      throw new Error("Deleted story manifest replacement exceeds its size bound");
    }
    return manifest;
  }

  async stageManifest(manifest: StoryManifestV6): Promise<void> {
    if (manifest.id !== this.storyId) throw new Error("Story replacement changed aggregate identity");
    const bytes = Buffer.from(formatV6(manifest), "utf8");
    const maxBytes = manifest.kind === "deleted"
      ? MAX_DELETED_STORY_MANIFEST_BYTES
      : MAX_STORY_MANIFEST_BYTES;
    if (bytes.byteLength > maxBytes) throw new Error("Story replacement exceeds its manifest bound");
    await publishPrivateFileNoReplace(this.nextManifestPath(), bytes, {
      label: MANIFEST_POLICY.label,
      maxBytes
    });
    this.staged = {
      manifest,
      clearCleanupOnPublish: this.preparedCleanupRetirement
    };
    this.preparedCleanupRetirement = false;
  }

  async publishStagedManifest(): Promise<void> {
    let staged = this.staged;
    if (staged === null) {
      const recovered = await this.readStagedManifest();
      if (recovered === null) throw new Error("Story manifest replacement is absent");
      // A replacement recovered from disk may belong to a transaction that
      // dropped references, so it never retires the cleanup marker.
      staged = { manifest: recovered, clearCleanupOnPublish: false };
    }
    const manifest = staged.manifest;
    await rename(this.nextManifestPath(), this.manifestPath());
    try {
      await syncDirectory(this.bundleDir);
    } catch (error) {
      throw new StoryDurabilityError(
        `Story manifest ${this.storyId} became visible but its durability could not be confirmed`,
        { cause: error }
      );
    }
    const manifestBytes = Buffer.from(formatV6(manifest), "utf8");
    const source = manifest.kind === "live"
      ? { kind: "v6-live" as const, manifest, manifestBytes }
      : { kind: "v6-deleted" as const, manifest, manifestBytes };
    this.currentSnapshot = {
      storageKind: "v6",
      manifest,
      manifestHash: hashStoryV6ManifestBytes(manifestBytes),
      projection: storyProjection(manifest),
      source
    };
    this.staged = null;
    if (staged.clearCleanupOnPublish) {
      // Objects this mutation wrote are referenced by the manifest that just
      // published, and it dropped nothing, so no sweep is owed. A failed
      // clear leaves the marker for the ordinary scheduled sweep.
      await afterCommit(`clearing additive-mutation recovery for story ${this.storyId}`, async () => {
        await clearCleanupPending(this.bundleDir, this.storyId);
      });
    }
  }

  async discardStagedManifest(): Promise<void> {
    await removePrivateFile(this.nextManifestPath(), MANIFEST_POLICY);
    this.staged = null;
  }

  private manifestPath(): string {
    return path.join(this.bundleDir, MANIFEST_FILE);
  }

  private nextManifestPath(): string {
    return path.join(this.bundleDir, NEXT_MANIFEST_FILE);
  }
}

export function requirePresentStorySlot(
  slot: StoredStorySlot,
  storyId: string
): asserts slot is PresentStorySlot {
  if ("mutationBlockedByResidue" in slot && slot.mutationBlockedByResidue === true) {
    throw new ServiceError(
      409,
      `Story ${storyId} has an unfinished storage transition`,
      "resource_busy"
    );
  }
  if (slot.kind === "absent" || slot.kind === "legacy") {
    throw new ServiceError(404, `Story not found: ${storyId}`);
  }
  if (slot.kind === "residue") {
    throw new ServiceError(
      409,
      `Story ${storyId} has an unfinished storage transition`,
      "resource_busy"
    );
  }
}
