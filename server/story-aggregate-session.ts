import {
  chmod,
  lstat,
  rename
} from "node:fs/promises";
import path from "node:path";
import { activePath } from "../shared/story-tree.js";
import type { Story } from "../shared/types.js";
import { resolveImageInputActivation } from "../shared/image-input-release.js";
import { ServiceError } from "./errors.js";
import {
  decodeStoryBundle,
  encodeStoryBundle,
  hydrateStoryNodes
} from "./story-codec.js";
import { pathTo } from "../shared/story-tree.js";
import {
  liveObjectIds,
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
import type { StoredStorySlot } from "./story-storage-reader.js";
import {
  formatV6,
  formatV8,
  MAX_DELETED_STORY_MANIFEST_BYTES,
  parseStoryManifestBytes,
  STORY_SCHEMA_VERSION_V8,
  storySummaryV6FromContent
} from "./story-v6-codec.js";
import type {
  StoryEnvelopeContent,
  StoryEnvelopeManifest,
  StorySummaryV6
} from "./story-v6-types.js";
import { MAX_STORY_MANIFEST_BYTES } from "./story-v5-strict.js";
import { LEAF_OBJECT_KINDS, StoryObjectStore, type LeafObjectKind } from "./story-objects.js";

const MANIFEST_FILE = "manifest.json";
const NEXT_MANIFEST_FILE = `${MANIFEST_FILE}.next`;
const MANIFEST_POLICY = {
  label: "Story manifest replacement",
  maxBytes: MAX_STORY_MANIFEST_BYTES
} as const;

/** A staged manifest owns immutable objects that the current manifest does
 * not own yet. Cleanup must keep all objects until recovery publishes or
 * discards this file. */
export async function stagedStoryManifestExists(bundleDir: string): Promise<boolean> {
  return await readOptionalPrivateFile(
    path.join(bundleDir, NEXT_MANIFEST_FILE),
    MANIFEST_POLICY
  ) !== null;
}

type PresentStorySlot = Extract<
  StoredStorySlot,
  { kind: "v5" | "v6-live" | "v6-deleted" }
>;

export interface PreparedStoryContent {
  readonly story: Story;
  readonly content: StoryEnvelopeContent;
  readonly summary: StorySummaryV6;
}

export interface PrepareStoryContentOptions {
  /** The one site that decides whether ONE encode may build the successor
   *  content payload. Absent resolves through `resolveImageInputActivation()`
   *  (`shared/image-input-release.ts`), so production callers that never set
   *  this stay on the release default. Even when this resolves true, the
   *  encode only actually uses the successor payload if `story` carries an
   *  Image Attachment; a story with none stays on the current schema, so
   *  turning activation on never rewrites an unrelated story. */
  readonly activation?: boolean;
}

/** A generation record source-revision graph this session hash-verified,
 * paired with the manifest hash it was verified against. A caller may hand
 * this back into a later session's constructor for the same story; it is
 * only ever adopted there if that session's starting manifest hash still
 * matches — otherwise it is discarded, same as `liveGraph` below. */
export interface GenerationRecordSourceRevisionSnapshot {
  readonly manifestHash: string;
  readonly sourceRevisions: ReadonlyMap<ObjectHash, readonly ObjectHash[]>;
}

/** One story-scope-held filesystem view. Callers own coordinator admission and
 * the StoryStore's per-story I/O lock for this session's complete lifetime. */
export class StoryAggregateSession {
  private currentSnapshot: StoryAggregateSnapshot;
  private readonly bundleDir: string;
  /** The staged replacement carries its own cleanup verdict, so a manifest
   * recovered from disk can never retire a marker another transaction owes. */
  private staged: {
    readonly manifest: StoryEnvelopeManifest;
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
  /** Generation record source-revision graph carried in from a prior session
   * for this same story. Replaced wholesale (never merged) by prepareContent
   * + publishStagedManifest, so it always reflects exactly one manifest
   * hash's worth of trust. */
  private generationRecordGraph: GenerationRecordSourceRevisionSnapshot | null;
  /** The graph prepareContent just verified, narrowed to the manifest it
   * staged, held here until publishStagedManifest learns that manifest's
   * durable hash and can pair the two into `generationRecordGraph`. */
  private preparedGenerationRecordGraph: ReadonlyMap<ObjectHash, readonly ObjectHash[]> | null = null;

  get snapshot(): StoryAggregateSnapshot {
    return this.currentSnapshot;
  }

  /** This session's most recently verified generation record graph, for a
   * caller to hold and pass into the next session for this story id. */
  get capturedGenerationRecordGraph(): GenerationRecordSourceRevisionSnapshot | null {
    return this.generationRecordGraph;
  }

  constructor(
    storyRoot: string,
    readonly storyId: string,
    slot: PresentStorySlot,
    priorGenerationRecordGraph: GenerationRecordSourceRevisionSnapshot | null = null
  ) {
    this.bundleDir = path.join(storyRoot, storyId);
    this.currentSnapshot = storyAggregateSnapshot(slot);
    this.generationRecordGraph = priorGenerationRecordGraph;
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

  async prepareContent(
    story: Story,
    options: PrepareStoryContentOptions = {}
  ): Promise<PreparedStoryContent> {
    if (story.id !== this.storyId) throw new Error("Story mutation changed aggregate identity");
    if (this.snapshot.manifest.kind !== "live") {
      throw new ServiceError(404, `Story not found: ${this.storyId}`);
    }
    this.preparedCleanupRetirement = false;
    const previousLive = liveObjectIds(this.snapshot.manifest.content);
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
      objects.adoptCommittedIds("revisions", previousLive.revisions);
      for (const kind of LEAF_OBJECT_KINDS) objects.adoptCommittedIds(kind, previousLive.leaves[kind]);
    }
    if (this.generationRecordGraph !== null && this.generationRecordGraph.manifestHash === this.snapshot.manifestHash) {
      // Same trust-by-induction rule as the revision graph above, narrowed to
      // records: each entry was hash-verified and parsed by a prior session
      // whose starting manifest is still this session's starting manifest.
      objects.adoptKnownGenerationRecordGraph(this.generationRecordGraph.sourceRevisions, { committed: true });
    }
    // The single site that decides whether this encode builds the successor
    // content payload. Release-wide activation alone is not enough: a story
    // that carries no Image Attachment stays on the current schema even with
    // activation on, so turning the switch on never upgrades a library that
    // has nothing to gain from it (see `PrepareStoryContentOptions`).
    const buildSuccessorContent = resolveImageInputActivation(options.activation)
      && storyHasImageAttachments(story);
    const content = await encodeStoryBundle(
      story,
      objects,
      undefined,
      undefined,
      buildSuccessorContent ? { activation: true } : {}
    );
    await objects.flush();
    const nextLive = liveObjectIds(content);
    await objects.verifyGraph(nextLive);
    const nextRevisionIds = new Set(nextLive.revisions);
    const nextLeafIds = {} as Record<LeafObjectKind, Set<ObjectHash>>;
    for (const kind of LEAF_OBJECT_KINDS) nextLeafIds[kind] = new Set(nextLive.leaves[kind]);
    const nextGenerationRecordIds = new Set(nextLive.generationRecords);
    this.preparedGenerationRecordGraph = new Map(
      [...objects.verifiedGenerationRecordGraph()].filter(([hash]) => nextGenerationRecordIds.has(hash))
    );
    // Parsing normalizes V2-V4 sources before this diff can run (old fact
    // states collapse to their selected revision), so objects the
    // normalization dropped never appear in previousLive.revisions. Mirror
    // the V5 save path: a legacy-schema source always owes the first V5 sweep.
    // A dropped node's revision can still be live through a surviving node
    // that shares its text, so the revision check alone misses a dropped
    // node's own Generation Record — check that set too.
    this.preparedCleanupRetirement = await cleanup.settle(
      this.legacySchemaSource
        || previousLive.revisions.some((id) => !nextRevisionIds.has(id))
        || LEAF_OBJECT_KINDS.some((kind) =>
            previousLive.leaves[kind].some((id) => !nextLeafIds[kind].has(id)))
        || previousLive.generationRecords.some((id) => !nextGenerationRecordIds.has(id))
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

  async readStagedManifest(): Promise<StoryEnvelopeManifest | null> {
    const bytes = await readOptionalPrivateFile(
      this.nextManifestPath(),
      MANIFEST_POLICY
    );
    if (bytes === null) return null;
    const parsed = parseStoryManifestBytes(bytes, this.storyId);
    if (parsed.kind === "v5") {
      throw new Error("Story manifest replacement cannot regress to V5");
    }
    // `stageManifest` below picks the envelope version from the content the
    // transaction produced (`server/story-v6-reducer.ts`), so a staged V6 or
    // V8 `.next` file is equally a legitimate in-flight replacement here.
    const manifest = parsed.manifest;
    if (manifest.kind === "deleted"
      && bytes.byteLength > MAX_DELETED_STORY_MANIFEST_BYTES) {
      throw new Error("Deleted story manifest replacement exceeds its size bound");
    }
    return manifest;
  }

  async stageManifest(manifest: StoryEnvelopeManifest): Promise<void> {
    if (manifest.id !== this.storyId) throw new Error("Story replacement changed aggregate identity");
    // Publishing any manifest from a legacy-schema V5 snapshot wraps the
    // already-normalized content into V6 and erases sourceSchemaVersion, so
    // the first V5 sweep obligation must be durable before the wrap can
    // stage — whichever path stages it. A provider start reaches here
    // without prepareContent.
    if (this.legacySchemaSource) await this.ensureCleanupPending();
    const bytes = Buffer.from(formatManifestEnvelope(manifest), "utf8");
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
    const manifestBytes = Buffer.from(formatManifestEnvelope(manifest), "utf8");
    // Reuse the exact hashing and projection a fresh reload would apply
    // (`storyAggregateSnapshot`), so a just-published V8 upgrade is snapshotted
    // in memory precisely as the next `withAggregateSession` call would read
    // it back off disk.
    this.currentSnapshot = storyAggregateSnapshot(persistedSlotFromManifest(manifest, manifestBytes));
    this.staged = null;
    if (this.preparedGenerationRecordGraph !== null) {
      // Only prepareContent (run in this same session, against the manifest
      // that just published) sets this, so it can only ever pair with the
      // manifest hash that graph was actually verified against.
      this.generationRecordGraph = {
        manifestHash: this.currentSnapshot.manifestHash,
        sourceRevisions: this.preparedGenerationRecordGraph
      };
      this.preparedGenerationRecordGraph = null;
    }
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
    this.preparedGenerationRecordGraph = null;
  }

  /** True while the committed source predates schema 5. Parsing already
   * normalized the content, so this flag is the only remaining evidence that
   * objects hidden by that normalization still owe the first V5 sweep. */
  private get legacySchemaSource(): boolean {
    const source = this.snapshot.source;
    return source.kind === "v5" && source.sourceSchemaVersion !== STORY_SCHEMA_VERSION;
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
  // The aggregate session exists to prepare and stage a mutation, so a
  // successor-schema manifest must refuse it here exactly as
  // `requireMutableStorySlot` refuses it for the older direct-write path
  // (`server/story-storage-reader.ts`). This release never opens a session
  // over a story that already needs a successor release to mutate.
  if (slot.kind === "v8-live" || slot.kind === "v8-deleted") {
    throw new ServiceError(
      409,
      `Story ${storyId} uses a manifest that requires a successor release for mutation`,
      "story_manifest_requires_successor"
    );
  }
}

/** True once any take in `story` carries an Image Attachment. This is the
 *  other half of `prepareContent`'s successor decision: release-wide
 *  activation says a write MAY use the successor schema, this says one
 *  actually NEEDS it, and only both together justify it (requirement: a story
 *  with no attachments stays on the current schema even with activation on). */
function storyHasImageAttachments(story: Story): boolean {
  return story.nodes.some((node) => node.imageAttachments !== undefined);
}

/** `formatV6` and `formatV8` differ only in which schema literal they accept;
 *  this is the one place a staged or published manifest picks between them,
 *  by the schema version its own content already carries
 *  (`server/story-v6-reducer.ts` is the one place that decides that version). */
function formatManifestEnvelope(manifest: StoryEnvelopeManifest): string {
  return manifest.schemaVersion === STORY_SCHEMA_VERSION_V8 ? formatV8(manifest) : formatV6(manifest);
}

/** The persisted-slot shape a freshly published envelope becomes, matched to
 *  `readStoredStorySlot`'s own discriminant so `storyAggregateSnapshot` can
 *  hash and project it exactly as a reload from disk would. */
function persistedSlotFromManifest(
  manifest: StoryEnvelopeManifest,
  manifestBytes: Buffer
): Extract<StoredStorySlot, { kind: "v6-live" | "v6-deleted" | "v8-live" | "v8-deleted" }> {
  if (manifest.schemaVersion === STORY_SCHEMA_VERSION_V8) {
    return manifest.kind === "live"
      ? { kind: "v8-live", manifest, manifestBytes }
      : { kind: "v8-deleted", manifest, manifestBytes };
  }
  return manifest.kind === "live"
    ? { kind: "v6-live", manifest, manifestBytes }
    : { kind: "v6-deleted", manifest, manifestBytes };
}
