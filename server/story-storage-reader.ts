import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { Story } from "../shared/types.js";
import { FileSizeLimitError, readBoundedFile } from "./bounded-file.js";
import { ServiceError } from "./errors.js";
import { StoryFormatError } from "./story-format-facts.js";
import {
  liveObjectIds,
  parseLegacyStory,
  parseLegacyManifestWithoutSizeLimit,
  STORY_SUCCESSOR_SCHEMA_VERSION,
  type StoryManifestV5
} from "./story-format.js";
import type { LiveStoryObjectIds } from "./story-objects.js";
import { readOversizeLegacyManifestBytes } from "./json-schema-version.js";
import { MAX_STORY_MANIFEST_BYTES } from "./story-v5-strict.js";
import { parseStoryManifestBytes } from "./story-v6-codec.js";
import { readUnsealedFile } from "./vault-file-read.js";
import type { DeletedStoryManifestV6, LiveStoryManifestV6, ParsedStoryManifest } from "./story-v6-types.js";
import type { DeletedStoryManifestV8, LiveStoryManifestV8 } from "./story-v8-types.js";
import {
  classifyStoryEntry,
  isStoryId,
  legacyStoryResidueNames,
  MAX_STORY_RESIDUE_IDENTITY_BYTES,
  parseStoryResidueIdentityBytes,
  storyResidueIdentityName,
  storyResidueIdentityTempName,
  storyResidueNames,
  type StoryResidueIdentity,
  type StoryResidueKind
} from "./story-residue.js";

export type StoredStorySlot =
  | { kind: "absent" }
  | { kind: "residue"; residueKind: StoryResidueKind }
  | { kind: "legacy"; story: Story; raw: Buffer }
  | {
      kind: "v5";
      manifest: StoryManifestV5;
      manifestBytes: Buffer;
      sourceSchemaVersion: 2 | 3 | 4 | 5;
      mutationBlockedByResidue?: true;
    }
  | {
      kind: "v6-live";
      manifest: LiveStoryManifestV6;
      manifestBytes: Buffer;
      mutationBlockedByResidue?: true;
    }
  | {
      kind: "v6-deleted";
      manifest: DeletedStoryManifestV6;
      manifestBytes: Buffer;
      mutationBlockedByResidue?: true;
    }
  | {
      kind: "v8-live";
      manifest: LiveStoryManifestV8;
      manifestBytes: Buffer;
      mutationBlockedByResidue?: true;
    }
  | {
      kind: "v8-deleted";
      manifest: DeletedStoryManifestV8;
      manifestBytes: Buffer;
      mutationBlockedByResidue?: true;
    };

export type MutableStorySlot = Extract<StoredStorySlot, { kind: "absent" | "legacy" | "v5" }>;
export type StoryMetadata = Pick<Story, "id" | "title" | "createdAt" | "origin">;

export function storyMetadataFromSlot(
  slot: Extract<StoredStorySlot, { kind: "legacy" | "v5" | "v6-live" | "v8-live" }>
): StoryMetadata {
  const source = slot.kind === "legacy" ? slot.story : slot.kind === "v5" ? slot.manifest : slot.manifest.content;
  return {
    id: source.id,
    title: source.title,
    createdAt: source.createdAt,
    ...(source.origin === undefined ? {} : { origin: { ...source.origin } })
  };
}

export async function readOptionalStoryFile(file: string): Promise<Buffer | null> {
  try {
    return await readUnsealedFile(file);
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENAMETOOLONG")) return null;
    throw error;
  }
}

export function requireMutableStorySlot(
  slot: StoredStorySlot,
  storyId: string
): asserts slot is MutableStorySlot {
  if ("mutationBlockedByResidue" in slot && slot.mutationBlockedByResidue === true) {
    throw new ServiceError(409, `Story ${storyId} has an unfinished storage transition`, "resource_busy");
  }
  if (
    slot.kind === "v6-live"
    || slot.kind === "v6-deleted"
    || slot.kind === "v8-live"
    || slot.kind === "v8-deleted"
  ) {
    throw new ServiceError(
      409,
      `Story ${storyId} uses a manifest that requires a successor release for mutation`,
      "story_manifest_requires_successor"
    );
  }
  if (slot.kind === "residue") {
    throw new ServiceError(409, `Story ${storyId} has an unfinished storage transition`, "resource_busy");
  }
}

const EMPTY_LIVE_STORY_OBJECT_IDS: LiveStoryObjectIds = {
  revisions: [],
  leaves: { probabilities: [], reasoning: [], images: [] }
};

/**
 * The ids one sweep pass must protect for a slot, switched over every
 * `StoredStorySlot` member so a kind this function does not know about fails
 * to compile instead of silently sweeping as if nothing were live. This is
 * the third site of the same bug class: two earlier call sites each narrowed
 * `StoredStorySlot` by hand and separately forgot a successor member
 * (`requirePresentStorySlot` in server/story-aggregate-session.ts,
 * `server/story-reaper.ts`). Routing every sweep-scoped read through one
 * exhaustive function, instead of one more hand-written `if` chain, makes a
 * fourth miss a compiler error rather than a review-discipline hope.
 *
 * A live kind (`v5`, `v6-live`, `v8-live`) protects its manifest's own ids.
 * A deleted kind (`v6-deleted`, `v8-deleted`) protects none of its own, but
 * still returns an explicit empty set rather than `null`: the caller must
 * still run its sweep pass so any object the manifest no longer references
 * gets reaped, the difference between "reap what is left" and "the cleanup
 * marker stays set forever" (the exact defect this function replaces).
 * Every other kind (`absent`, `residue`, `legacy`) has no story-object
 * bundle for a sweep to examine, so there is nothing for a sweep to do.
 */
export function storySlotSweepLiveIds(slot: StoredStorySlot): LiveStoryObjectIds | null {
  switch (slot.kind) {
    case "v5":
      return liveObjectIds(slot.manifest);
    case "v6-live":
    case "v8-live":
      return liveObjectIds(slot.manifest.content);
    case "v6-deleted":
    case "v8-deleted":
      return EMPTY_LIVE_STORY_OBJECT_IDS;
    case "absent":
    case "residue":
    case "legacy":
      return null;
    default:
      return assertNeverStorySlotKind(slot);
  }
}

function assertNeverStorySlotKind(slot: never): never {
  throw new StoryFormatError(`Unhandled story slot kind: ${String((slot as { kind: unknown }).kind)}`);
}

/** Resolve canonical state and reserved successor siblings as one filesystem slot. */
export async function readStoredStorySlot(root: string, storyId: string): Promise<StoredStorySlot> {
  requireStoryId(storyId);
  const bundle = path.join(root, storyId);
  const canonical = await lstatIfPresent(bundle);
  if (canonical !== null && !canonical.isDirectory()) {
    throw new StoryFormatError(`Story bundle path is not a directory: ${storyId}`);
  }
  const residues = await existingResidues(root, storyId);
  if (residues.length > 1 || (canonical !== null && residues.some(
    (residue) => residue.naming === "legacy" || residue.directory
  ))) {
    throw new StoryFormatError(`Conflicting canonical/residue state for story: ${storyId}`);
  }
  if (canonical === null && residues[0] !== undefined) {
    const legacy = await lstatOptionalConstructedPath(path.join(root, `${storyId}.json`));
    if (legacy !== null) throw new StoryFormatError(`Conflicting legacy/residue state for story: ${storyId}`);
    return { kind: "residue", residueKind: residues[0].residueKind };
  }
  if (canonical !== null) {
    const manifestFile = path.join(bundle, "manifest.json");
    const parsed = await parseStoredManifest(manifestFile, storyId);
    const slot = slotFromParsedManifest(parsed);
    return residues.length === 0 ? slot : { ...slot, mutationBlockedByResidue: true };
  }

  const legacyPath = path.join(root, `${storyId}.json`);
  const legacyInfo = await lstatOptionalConstructedPath(legacyPath);
  if (legacyInfo === null) return { kind: "absent" };
  if (!legacyInfo.isFile()) throw new StoryFormatError(`Legacy story path is not a regular file: ${storyId}`);
  const raw = await readUnsealedFile(legacyPath);
  return { kind: "legacy", story: parseLegacyStory(raw.toString("utf8"), storyId), raw };
}

/** One `if` per parsed kind, not a shared ternary, so each branch's `kind`
 * literal stays tied to its own `manifest` type. A single object built from
 * `parsed.kind` and `parsed.manifest` directly would widen both to the union
 * of every remaining variant and stop matching any one member of
 * `StoredStorySlot`. */
function slotFromParsedManifest(
  parsed: ParsedStoryManifest & { manifestBytes: Buffer }
): Exclude<StoredStorySlot, { kind: "absent" | "residue" | "legacy" }> {
  if (parsed.kind === "v5") {
    return {
      kind: "v5",
      manifest: parsed.manifest,
      manifestBytes: parsed.manifestBytes,
      sourceSchemaVersion: parsed.sourceSchemaVersion
    };
  }
  if (parsed.kind === "v6-live") {
    return { kind: "v6-live", manifest: parsed.manifest, manifestBytes: parsed.manifestBytes };
  }
  if (parsed.kind === "v6-deleted") {
    return { kind: "v6-deleted", manifest: parsed.manifest, manifestBytes: parsed.manifestBytes };
  }
  if (parsed.kind === "v8-live") {
    return { kind: "v8-live", manifest: parsed.manifest, manifestBytes: parsed.manifestBytes };
  }
  return { kind: "v8-deleted", manifest: parsed.manifest, manifestBytes: parsed.manifestBytes };
}

async function parseStoredManifest(file: string, storyId: string) {
  try {
    const bytes = await readBoundedFile(file, MAX_STORY_MANIFEST_BYTES, `story ${storyId} manifest`);
    return { ...parseStoryManifestBytes(bytes, storyId), manifestBytes: bytes };
  } catch (error) {
    if (!(error instanceof FileSizeLimitError)) throw error;
    const raw = await readOversizeLegacyManifestBytes(file, `story ${storyId} manifest`);
    if (raw === null) throw error;
    const parsed = parseLegacyManifestWithoutSizeLimit(raw.toString("utf8"), storyId);
    // parseLegacyManifestWithoutSizeLimit only ever accepts 2, 3, or 4; see
    // the matching comment in server/story-v6-codec.ts.
    if (parsed.sourceSchemaVersion === STORY_SUCCESSOR_SCHEMA_VERSION) {
      throw new StoryFormatError(`Story ${storyId} legacy manifest reported an impossible schema version`);
    }
    return {
      kind: "v5" as const,
      manifest: parsed.manifest,
      manifestBytes: raw,
      sourceSchemaVersion: parsed.sourceSchemaVersion
    };
  }
}

/** Typed residue is ignored; final identity records are bounded and validated. */
export async function catalogStoryIds(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const states = new Map<string, Set<"canonical" | "legacy" | StoryResidueKind>>();
  const residueCounts = new Map<string, number>();
  const hashedDirectories = new Set<string>();
  const finalIdentities = new Map<string, StoryResidueIdentity>();
  const finalKindsByStory = new Map<string, Set<StoryResidueKind>>();
  for (const entry of entries) {
    const legacyId = legacyStoryId(entry);
    if (legacyId !== null) {
      addState(states, legacyId, "legacy");
      continue;
    }
    const classified = classifyStoryEntry(entry);
    if (classified.kind === "canonical-story") addState(states, classified.storyId, "canonical");
    else if (classified.kind === "story-residue") {
      addState(states, classified.storyId, classified.residueKind);
      incrementResidueCount(residueCounts, classified.storyId);
    } else if (classified.kind === "story-residue-identity" && classified.phase === "final") {
      const bytes = await readBoundedFile(
        path.join(root, entry.name),
        MAX_STORY_RESIDUE_IDENTITY_BYTES,
        `story residue identity ${entry.name}`
      );
      const identity = parseStoryResidueIdentityBytes(bytes);
      if (identity.token !== classified.token || identityKind(identity) !== classified.residueKind) {
        throw new StoryFormatError(`Story residue identity name does not match its contents: ${entry.name}`);
      }
      finalIdentities.set(residueKey(classified.residueKind, classified.token), identity);
      addResidueKind(finalKindsByStory, identity.storyId, classified.residueKind);
    } else if (classified.kind === "hashed-story-residue") {
      hashedDirectories.add(residueKey(classified.residueKind, classified.token));
    }
    // Typed temps are non-authoritative. Their node type was checked above;
    // scans deliberately ignore their possibly incomplete bytes.
  }
  for (const key of hashedDirectories) {
    const identity = finalIdentities.get(key);
    if (identity === undefined) {
      throw new StoryFormatError(`Story residue directory lacks its final identity: ${key}`);
    }
    const authoritative = states.get(identity.storyId);
    if (authoritative?.has("canonical") || authoritative?.has("legacy")) {
      throw new StoryFormatError(`Conflicting canonical/residue directory state: ${identity.storyId}`);
    }
  }
  for (const [storyId, kinds] of finalKindsByStory) {
    const oldState = states.get(storyId);
    const oldResidueCount = residueCounts.get(storyId) ?? 0;
    if (kinds.size > 1 || oldResidueCount > 0 || oldState?.has("legacy")) {
      throw new StoryFormatError(`Conflicting story residue state: ${storyId}`);
    }
  }
  const ids: string[] = [];
  for (const [storyId, state] of states) {
    const hasStory = state.has("canonical") || state.has("legacy");
    const residueCount = residueCounts.get(storyId) ?? 0;
    if (residueCount > 1 || (residueCount > 0 && hasStory)) {
      throw new StoryFormatError(`Conflicting canonical/residue state for story: ${storyId}`);
    }
    if (hasStory) ids.push(storyId);
  }
  return ids;
}

function legacyStoryId(entry: Dirent): string | null {
  if (!entry.name.endsWith(".json")) return null;
  const storyId = entry.name.slice(0, -5);
  if (!isStoryId(storyId)) return null;
  if (!entry.isFile()) throw new StoryFormatError(`Legacy story entry is not a regular file: ${entry.name}`);
  return storyId;
}

interface ExistingResidue {
  residueKind: StoryResidueKind;
  naming: "hashed" | "legacy";
  directory: boolean;
}

async function existingResidues(root: string, storyId: string): Promise<ExistingResidue[]> {
  const canonical = storyResidueNames(storyId);
  const legacy = legacyStoryResidueNames(storyId);
  const results = await Promise.all((["create", "reap"] as const).map(async (kind) => ({
    kind,
    residue: await inspectResidue(root, storyId, kind, canonical[kind], legacy[kind])
  })));
  return results.flatMap(({ residue }) => residue === null ? [] : [residue]);
}

async function inspectResidue(
  root: string,
  storyId: string,
  kind: StoryResidueKind,
  directoryName: string,
  legacyName: string
): Promise<ExistingResidue | null> {
  const identityName = storyResidueIdentityName(kind, storyId);
  const tempName = storyResidueIdentityTempName(kind, storyId);
  const [directory, identity, temp, legacy] = await Promise.all([
    lstatOptionalConstructedPath(path.join(root, directoryName)),
    lstatOptionalConstructedPath(path.join(root, identityName)),
    lstatOptionalConstructedPath(path.join(root, tempName)),
    lstatOptionalConstructedPath(path.join(root, legacyName))
  ]);
  if (directory !== null && !directory.isDirectory()) {
    throw new StoryFormatError(`Story ${kind} residue is not a directory: ${directoryName}`);
  }
  if (identity !== null && !identity.isFile()) {
    throw new StoryFormatError(`Story ${kind} identity is not a regular file: ${identityName}`);
  }
  if (temp !== null && !temp.isFile()) {
    throw new StoryFormatError(`Story ${kind} identity temp is not a regular file: ${tempName}`);
  }
  if (legacy !== null && !legacy.isDirectory()) {
    throw new StoryFormatError(`Story ${kind} residue is not a directory: ${legacyName}`);
  }
  if (directory !== null && identity === null) {
    throw new StoryFormatError(`Story ${kind} residue lacks its final identity: ${directoryName}`);
  }
  if (identity !== null) {
    const bytes = await readBoundedFile(
      path.join(root, identityName),
      MAX_STORY_RESIDUE_IDENTITY_BYTES,
      `story ${storyId} ${kind} identity`
    );
    parseStoryResidueIdentityBytes(bytes, { storyId, residueKind: kind });
  }
  const hashedPresent = directory !== null || identity !== null || temp !== null;
  if (hashedPresent && legacy !== null) {
    throw new StoryFormatError(`Conflicting ${kind} residue state for story: ${storyId}`);
  }
  if (hashedPresent) return { residueKind: kind, naming: "hashed", directory: directory !== null };
  return legacy === null ? null : { residueKind: kind, naming: "legacy", directory: true };
}

function addState(
  states: Map<string, Set<"canonical" | "legacy" | StoryResidueKind>>,
  storyId: string,
  state: "canonical" | "legacy" | StoryResidueKind
): void {
  const current = states.get(storyId) ?? new Set();
  current.add(state);
  states.set(storyId, current);
}

function incrementResidueCount(counts: Map<string, number>, storyId: string): void {
  counts.set(storyId, (counts.get(storyId) ?? 0) + 1);
}

function addResidueKind(
  states: Map<string, Set<StoryResidueKind>>,
  storyId: string,
  kind: StoryResidueKind
): void {
  const kinds = states.get(storyId) ?? new Set<StoryResidueKind>();
  kinds.add(kind);
  states.set(storyId, kinds);
}

function identityKind(identity: StoryResidueIdentity): StoryResidueKind {
  return identity.kind === "story-create-reservation" ? "create" : "reap";
}

function residueKey(kind: StoryResidueKind, token: string): string {
  return `${kind}:${token}`;
}

async function lstatIfPresent(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

/** A protocol-valid ID may make an optional sibling name exceed the host
 * component limit. Such a path cannot exist on that filesystem. */
async function lstatOptionalConstructedPath(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENAMETOOLONG")) return null;
    throw error;
  }
}

function requireStoryId(storyId: string): void {
  if (!isStoryId(storyId)) throw new StoryFormatError(`Invalid story id: ${storyId}`);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
