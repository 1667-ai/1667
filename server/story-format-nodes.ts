import {
  isTagStatus,
  MAX_GENERATION_RECORD_IDS,
  MAX_RECENT_LINES,
  type HumanEditAttribution,
  type TextRange
} from "../shared/types.js";
import { assertStoryImageAttachments, ImageAttachmentError, type StoryImageAttachment } from "../shared/image-attachment.js";
import {
  StoryFormatError,
  arrayField,
  arrayValue,
  integerField,
  optionalString,
  parseRewrittenSpans,
  parseSingleAttribution,
  parseStoredFacts,
  parseVersionAttributions,
  recordValue,
  requireHash,
  stringField
} from "./story-format-facts.js";
import { unicodeScalarLength } from "../shared/unicode.js";
import type {
  ObjectHash,
  StoredFactV1,
  StoredFactV13,
  StoredBranchV1,
  StoredTagV1,
  StoredNodeV1,
  StoredPartV2,
  StoryManifestV3,
  StoryManifestV4,
  StoryManifestV5,
  StoryManifestV7,
  StoryManifestV9,
  StoryManifestV11,
  StoryManifestV13
} from "./story-format.js";
import { SYNTHETIC_EMPTY_REVISION_ID } from "./story-empty-revision.js";
import { parseStoredChapterNode } from "./story-format-chapters.js";
import type { LiveStoryObjectIds } from "./story-objects.js";

const LEGACY_MAX_VERSIONS = 10;
const LEGACY_MAX_BRANCHES = 32;

export function parseStoredPart(value: unknown, label: string): StoredPartV2 {
  const part = recordValue(value, label);
  const revisionIds = arrayField(part, "revisionIds").map((hash, index) =>
    requireHash(hash, `${label}.revisionIds[${index}]`)
  );
  if (revisionIds.length === 0) throw new StoryFormatError(`${label}.revisionIds must not be empty`);
  if (revisionIds.length > LEGACY_MAX_VERSIONS) {
    throw new StoryFormatError(`${label}.revisionIds exceeds the ${LEGACY_MAX_VERSIONS}-version limit`);
  }
  const activeRevision = integerField(part, "activeRevision");
  if (activeRevision < 0 || activeRevision >= revisionIds.length) {
    throw new StoryFormatError(`${label}.activeRevision is out of range`);
  }
  const genId = optionalString(part.genId, `${label}.genId`);
  const role = optionalRole(part.role, `${label}.role`);
  const versionAttributions = parseVersionAttributions(
    part.versionAttributions,
    `${label}.versionAttributions`,
    revisionIds.length
  );
  return {
    id: stringField(part, "id"),
    instruction: stringField(part, "instruction"),
    model: stringField(part, "model"),
    createdAt: stringField(part, "createdAt"),
    ...(genId === undefined ? {} : { genId }),
    ...(role === undefined ? {} : { role }),
    revisionIds,
    activeRevision,
    ...(versionAttributions === undefined ? {} : { versionAttributions })
  };
}

export function parseLegacyManifest(value: Record<string, unknown>): StoryManifestV3 {
  const parts = arrayField(value, "parts").map((part, index) => parseStoredPart(part, `parts[${index}]`));
  const branches = value.schemaVersion === 2 ? [] : parseStoredBranches(value.branches, parts);
  const allIds = [...parts, ...branches.flatMap((branch) => branch.parts)].map((part) => part.id);
  const activeWordCount = integerField(value, "activeWordCount");
  if (activeWordCount < 0) throw new StoryFormatError("activeWordCount must not be negative");
  return {
    format: "1667-story",
    schemaVersion: 3,
    id: stringField(value, "id"),
    title: stringField(value, "title"),
    createdAt: stringField(value, "createdAt"),
    updatedAt: stringField(value, "updatedAt"),
    activeWordCount,
    parts,
    facts: parseStoredFacts(value.facts, allIds),
    branches,
    activeBranchId: value.schemaVersion === 2 ? null : parseActiveBranchId(value.activeBranchId, branches)
  };
}

export function convertV3ToV4(source: StoryManifestV3): StoryManifestV4 {
  const nodes: StoredNodeV1[] = [];
  const tags: StoredTagV1[] = [];
  const activeByPart = new Map<string, StoredNodeV1>();
  let previousBase: StoredNodeV1 | null = null;
  for (const part of source.parts) {
    const group = appendPartTakes(nodes, part, previousBase?.id ?? null);
    const active = group[part.activeRevision]!;
    activeByPart.set(part.id, active);
    if (previousBase !== null) previousBase.activeChildId = active.id;
    previousBase = active;
  }

  const branchPaths = new Map<string, StoredNodeV1[]>();
  for (const branch of source.branches) {
    const baseAnchor = branchAnchor(source.parts, activeByPart, branch);
    const clonesBoundary = branch.parts.length === 0
      || (baseAnchor !== null && branch.forkOffset === null
        && branch.forkPartId === source.parts.at(-1)?.id);
    // A branch after the final base part needs its own copy of that boundary,
    // even once it has a tail. Otherwise Main's terminal leaf becomes the
    // branch's parent and can no longer be selected as an ending.
    const anchor = clonesBoundary
      ? baseAnchor === null
        ? appendEmptyBranchTake(nodes, branch)
        : appendBranchBoundaryTake(nodes, baseAnchor, branch.id)
      : baseAnchor;
    let parentId = anchor === null ? null : anchor.id;
    const activeTail: StoredNodeV1[] = [];
    for (const part of branch.parts) {
      const group = appendPartTakes(nodes, part, parentId);
      const active = group[part.activeRevision]!;
      if (activeTail.length > 0) activeTail.at(-1)!.activeChildId = active.id;
      activeTail.push(active);
      parentId = active.id;
    }
    const prefix = branchPrefix(source.parts, activeByPart, branch);
    if (clonesBoundary && anchor !== null) {
      if (prefix.length === 0) prefix.push(anchor);
      else prefix[prefix.length - 1] = anchor;
    }
    const path = [...prefix, ...activeTail];
    branchPaths.set(branch.id, path);
    const head = activeTail[0];
    if (head !== undefined && anchor !== null && anchor.activeChildId === null) {
      anchor.activeChildId = head.id;
    }
    const target = activeTail.at(-1) ?? anchor;
    if (target !== null) addBranchTag(tags, branch, target.id);
  }

  let activePath = source.activeBranchId === null
    ? baseActivePath(source.parts, activeByPart)
    : branchPaths.get(source.activeBranchId) ?? [];
  if (activePath.length === 0 && source.activeBranchId !== null) {
    throw new StoryFormatError("activeBranchId does not resolve to a line");
  }
  for (let index = 0; index < activePath.length; index += 1) {
    activePath[index]!.activeChildId = activePath[index + 1]?.id ?? null;
  }
  const activeRootId = activePath[0]?.id ?? null;
  return {
    format: "1667-story",
    schemaVersion: 4,
    id: source.id,
    title: source.title,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    activeWordCount: source.activeWordCount,
    nodes,
    facts: source.facts,
    activeRootId,
    bookmarks: tags,
    recentNodeIds: []
  };
}

export function parseV4Manifest(input: unknown): StoryManifestV4 {
  // Keep the predecessor parser's exact all-node part-id domain.
  return parseV4ManifestWithFacts(input, parseStoredFacts, (nodes) => nodes.map((node) => node.id));
}

/** Parse the shared V4/V5/V7/V9/V11/V13 node graph with a caller-selected
 * Fact parser. The graph rules are identical; only V13 changes the Fact
 * payload, so keeping this hook avoids a second copy of node validation. V13
 * supplies separate source and Anchor node-id domains.
 */
export function parseV4ManifestWithFacts<F extends StoredFactV1 | StoredFactV13>(
  input: unknown,
  parseFacts: (
    value: unknown,
    sourcePartIds: readonly string[],
    anchorPartIds?: readonly string[]
  ) => F[],
  sourcePartIdsForFacts: (nodes: readonly StoredNodeV1[]) => readonly string[] = (nodes) =>
    nodes.map((node) => node.id),
  anchorPartIdsForFacts: (nodes: readonly StoredNodeV1[]) => readonly string[] = sourcePartIdsForFacts
): Omit<StoryManifestV4, "facts"> & { facts: F[] } {
  const value = recordValue(input, "manifest");
  const nodes = arrayField(value, "nodes").map((entry, index) => parseStoredNode(entry, index));
  const ids = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (ids.has(node.id)) throw new StoryFormatError(`Duplicate story node id: ${node.id}`);
    if (node.parentId !== null && !ids.has(node.parentId)) {
      throw new StoryFormatError(`nodes[${index}].parentId must reference an earlier node`);
    }
    ids.add(node.id);
  }
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  for (const [index, node] of nodes.entries()) {
    if (node.activeChildId === null) continue;
    const child = byId.get(node.activeChildId);
    if (child === undefined || child.parentId !== node.id) {
      throw new StoryFormatError(`nodes[${index}].activeChildId must reference a child`);
    }
  }
  const activeRootId = parseActiveRootId(value.activeRootId, nodes, byId);
  const tags = parseTags(value.bookmarks, ids);
  const recentNodeIds = arrayField(value, "recentNodeIds").map((entry, index) => {
    if (typeof entry !== "string" || !ids.has(entry)) {
      throw new StoryFormatError(`recentNodeIds[${index}] references an unknown node`);
    }
    return entry;
  });
  if (recentNodeIds.length > MAX_RECENT_LINES) {
    throw new StoryFormatError(`recentNodeIds exceeds the ${MAX_RECENT_LINES}-node limit`);
  }
  const activeWordCount = integerField(value, "activeWordCount");
  if (activeWordCount < 0) throw new StoryFormatError("activeWordCount must not be negative");
  const sourcePartIds = sourcePartIdsForFacts(nodes);
  const anchorPartIds = anchorPartIdsForFacts(nodes);
  return {
    format: "1667-story",
    schemaVersion: 4,
    id: stringField(value, "id"),
    title: stringField(value, "title"),
    createdAt: stringField(value, "createdAt"),
    updatedAt: stringField(value, "updatedAt"),
    activeWordCount,
    nodes,
    facts: parseFacts(
      value.facts,
      sourcePartIds,
      anchorPartIds
    ),
    activeRootId,
    bookmarks: tags,
    recentNodeIds
  };
}

/** Private: every direct caller wanted this beside `manifestTokenProbabilityIds`
 *  anyway, and calling them separately is exactly the lockstep risk
 *  `liveObjectIds` below exists to remove. `manifestTokenProbabilityIds`
 *  stays exported — server/story-snapshot.ts wants it alone, since it builds
 *  its revision map a different way (per node, not from this list). */
function manifestRevisionIds(
  manifest: StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9 | StoryManifestV11 | StoryManifestV13
): ObjectHash[] {
  return manifest.nodes.filter((node) => node.syntheticEmpty !== true).map((node) => node.revisionId)
    .concat(manifest.facts.flatMap((fact) => "states" in fact
      ? fact.states.flatMap((state) => state.revisionId === undefined ? [] : [state.revisionId])
      : [fact.revisionId]));
}

/** Every take's stored token probabilities id. Most nodes have none — the
 *  field is absent whenever a generation did not ask for them — so this is
 *  typically a small subset of `manifestRevisionIds`' length, not a parallel
 *  one-to-one list. */
export function manifestTokenProbabilityIds(
  manifest: StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9 | StoryManifestV11 | StoryManifestV13
): ObjectHash[] {
  const ids: ObjectHash[] = [];
  for (const node of manifest.nodes) {
    if (node.tokenProbabilityId !== undefined) ids.push(node.tokenProbabilityId);
  }
  return ids;
}

/** Every take's stored Generation Record ids, oldest first per node. Most
 *  nodes have none — old, human, and imported takes never gain one. */
export function manifestGenerationRecordIds(
  manifest: StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9 | StoryManifestV11 | StoryManifestV13
): ObjectHash[] {
  const ids: ObjectHash[] = [];
  for (const node of manifest.nodes) {
    if (node.generationRecordIds !== undefined) ids.push(...node.generationRecordIds);
  }
  return ids;
}

/** Every take's stored reasoning id, mirroring `manifestTokenProbabilityIds`
 *  exactly — most nodes have none. */
export function manifestReasoningIds(
  manifest: StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9 | StoryManifestV11 | StoryManifestV13
): ObjectHash[] {
  const ids: ObjectHash[] = [];
  for (const node of manifest.nodes) {
    if (node.reasoningId !== undefined) ids.push(node.reasoningId);
  }
  return ids;
}

/** Every take's stored Image Object ids, one manifest node can carry several
 *  (`nodes[].imageAttachments[].objectId`), unlike `tokenProbabilityId` and
 *  `reasoningId` above which each name at most one object per node. A V4 or
 *  V5 manifest never carries `imageAttachments` at all: the field exists
 *  only on the successor node shape (`server/story-v7-strict.ts`), so this
 *  returns an empty list for either, exactly like the other two collectors
 *  return nothing for a node with no stored id. */
export function manifestImageIds(
  manifest: StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9 | StoryManifestV11 | StoryManifestV13
): ObjectHash[] {
  const ids: ObjectHash[] = [];
  for (const node of manifest.nodes) {
    if (!("imageAttachments" in node) || node.imageAttachments === undefined) continue;
    for (const attachment of node.imageAttachments) ids.push(attachment.objectId);
  }
  return ids;
}

/** Every live id list for one manifest, kept as one object so a writer can
 *  never save one and silently drop another — the invariant that was
 *  previously held only by every call site remembering to call
 *  `manifestRevisionIds`, `manifestTokenProbabilityIds`, and
 *  `manifestReasoningIds` together (issue #291 structural review, finding
 *  F1). */
export function liveObjectIds(
  manifest: StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9 | StoryManifestV11 | StoryManifestV13
): LiveStoryObjectIds {
  return {
    revisions: manifestRevisionIds(manifest),
    leaves: {
      probabilities: manifestTokenProbabilityIds(manifest),
      reasoning: manifestReasoningIds(manifest),
      images: manifestImageIds(manifest),
      aside: manifestAsideIds(manifest)
    },
    generationRecords: manifestGenerationRecordIds(manifest)
  };
}

/** The story-level Aside document id, when present and non-null. */
export function manifestAsideIds(
  manifest: StoryManifestV4 | StoryManifestV5 | StoryManifestV7 | StoryManifestV9 | StoryManifestV11 | StoryManifestV13
): ObjectHash[] {
  const ids: ObjectHash[] = [];
  if ("asideDocumentId" in manifest && manifest.asideDocumentId !== null && manifest.asideDocumentId !== undefined) {
    ids.push(manifest.asideDocumentId);
  }
  if ("asideSessionRefs" in manifest) {
    ids.push(...manifest.asideSessionRefs.map((ref) => ref.documentId));
    ids.push(...manifest.asideUnanchoredSessionRefs.map((ref) => ref.documentId));
  }
  return [...new Set(ids)];
}

function appendPartTakes(nodes: StoredNodeV1[], part: StoredPartV2, parentId: string | null): StoredNodeV1[] {
  const group = part.revisionIds.map((revisionId, index): StoredNodeV1 => ({
    id: index === part.activeRevision ? part.id : `${part.id}@v${index}`,
    parentId,
    instruction: part.instruction,
    model: part.model,
    createdAt: part.createdAt,
    ...(part.genId === undefined ? {} : { genId: part.genId }),
    ...(part.role === undefined ? {} : { role: part.role }),
    revisionId,
    ...(part.versionAttributions?.[index] === undefined
      ? {}
      : { attribution: cloneAttribution(part.versionAttributions[index]!) }),
    activeChildId: null
  }));
  nodes.push(...group);
  return group;
}

/** Clone a complete boundary when the branch itself must own that ending: an
 * empty named line, or a tail after Main's final part. */
function appendBranchBoundaryTake(nodes: StoredNodeV1[], anchor: StoredNodeV1, branchId: string): StoredNodeV1 {
  const stem = `${anchor.id}@branch:${branchId}`;
  let id = stem;
  for (let suffix = 2; nodes.some((node) => node.id === id); suffix += 1) id = `${stem}:${suffix}`;
  const clone: StoredNodeV1 = {
    ...anchor,
    id,
    ...(anchor.attribution === undefined ? {} : { attribution: cloneAttribution(anchor.attribution) }),
    activeChildId: null
  };
  nodes.push(clone);
  return clone;
}

function appendEmptyBranchTake(nodes: StoredNodeV1[], branch: StoredBranchV1): StoredNodeV1 {
  const node: StoredNodeV1 = {
    id: uniqueBranchNodeId(nodes, "empty", branch.id),
    parentId: null,
    instruction: "",
    model: "legacy-migration",
    createdAt: branch.createdAt,
    preview: "",
    words: 0,
    ...(branch.label === "Summary" ? { role: "summary" as const } : {}),
    syntheticEmpty: true,
    revisionId: SYNTHETIC_EMPTY_REVISION_ID,
    activeChildId: null
  };
  nodes.push(node);
  return node;
}

function uniqueBranchNodeId(nodes: readonly StoredNodeV1[], kind: string, branchId: string): string {
  const stem = `legacy-${kind}@branch:${branchId}`;
  let id = stem;
  for (let suffix = 2; nodes.some((node) => node.id === id); suffix += 1) id = `${stem}:${suffix}`;
  return id;
}

function branchAnchor(
  base: StoredPartV2[],
  activeByPart: Map<string, StoredNodeV1>,
  branch: StoredBranchV1
): StoredNodeV1 | null {
  if (branch.forkPartId === null) return null;
  const index = base.findIndex((part) => part.id === branch.forkPartId);
  const anchorPartId = branch.forkOffset === null ? branch.forkPartId : index > 0 ? base[index - 1]!.id : null;
  if (anchorPartId === null) return null;
  const anchor = activeByPart.get(anchorPartId);
  // parseStoredBranches guarantees forkPartId ∈ base, and every base part has
  // an active take — a miss here is a parser bug, not a data shape.
  if (anchor === undefined) throw new StoryFormatError(`Missing migrated take for part: ${anchorPartId}`);
  return anchor;
}

function branchPrefix(
  base: StoredPartV2[],
  activeByPart: Map<string, StoredNodeV1>,
  branch: StoredBranchV1
): StoredNodeV1[] {
  if (branch.forkPartId === null) return [];
  const index = base.findIndex((part) => part.id === branch.forkPartId);
  const length = index + (branch.forkOffset === null ? 1 : 0);
  return base.slice(0, length).map((part) => activeByPart.get(part.id)!);
}

function baseActivePath(parts: StoredPartV2[], activeByPart: Map<string, StoredNodeV1>): StoredNodeV1[] {
  return parts.map((part) => activeByPart.get(part.id)!);
}

function addBranchTag(tags: StoredTagV1[], branch: StoredBranchV1, nodeId: string): void {
  if (tags.some((tag) => tag.nodeId === nodeId)) {
    console.error(`Story migration drift: tag collision on node ${nodeId}; keeping the first branch.`);
    return;
  }
  tags.push({
    nodeId,
    name: branch.name,
    // `canon` was authoritative in V3. The old UI could leave `label: "Canon"`
    // behind when canon moved to another branch, so only preserve that label
    // when the matching flag is still present. `branch.label` keeps its legacy
    // spelling, and so does the stored tag it becomes.
    label: branch.canon === true ? "Canon" : branch.label === "Canon" ? "" : branch.label,
    color: branch.color,
    createdAt: branch.createdAt
  });
}

function parseStoredNode(value: unknown, index: number): StoredNodeV1 {
  const label = `nodes[${index}]`;
  const node = recordValue(value, label);
  const parentId = nullableString(node.parentId, `${label}.parentId`);
  const activeChildId = nullableString(node.activeChildId, `${label}.activeChildId`);
  const attribution = parseSingleAttribution(node.attribution, `${label}.attribution`);
  const rewrittenSpans = parseRewrittenSpans(node.rewrittenSpans, `${label}.rewrittenSpans`);
  const human = optionalTrue(node.human, `${label}.human`);
  const syntheticEmpty = optionalTrue(node.syntheticEmpty, `${label}.syntheticEmpty`);
  const role = optionalRole(node.role, `${label}.role`);
  const updatedAt = optionalString(node.updatedAt, `${label}.updatedAt`);
  const genId = optionalString(node.genId, `${label}.genId`);
  const rewriteId = optionalString(node.rewriteId, `${label}.rewriteId`);
  const preview = optionalString(node.preview, `${label}.preview`);
  const words = node.words === undefined ? undefined : integerField(node, "words");
  const tokens = node.tokens === undefined ? undefined : integerField(node, "tokens");
  if ((preview === undefined) !== (words === undefined)) {
    throw new StoryFormatError(`${label}.preview and words must be stored together`);
  }
  if (preview !== undefined && unicodeScalarLength(preview, 100) > 100) {
    throw new StoryFormatError(`${label}.preview exceeds 100 characters`);
  }
  if (words !== undefined && words < 0) throw new StoryFormatError(`${label}.words must not be negative`);
  if (tokens !== undefined && tokens < 0) throw new StoryFormatError(`${label}.tokens must not be negative`);
  const chapter = parseStoredChapterNode(node, label);
  const tokenProbabilityId = node.tokenProbabilityId === undefined
    ? undefined
    : requireHash(node.tokenProbabilityId, `${label}.tokenProbabilityId`);
  const generationRecordIds = parseGenerationRecordIds(node.generationRecordIds, `${label}.generationRecordIds`);
  const reasoningId = node.reasoningId === undefined
    ? undefined
    : requireHash(node.reasoningId, `${label}.reasoningId`);
  const imageAttachments = parseStoredImageAttachments(node.imageAttachments, `${label}.imageAttachments`);
  const stored: StoredNodeV1 = {
    id: stringField(node, "id"),
    parentId,
    instruction: stringField(node, "instruction"),
    model: stringField(node, "model"),
    createdAt: stringField(node, "createdAt"),
    ...(preview === undefined ? {} : { preview, words: words! }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(genId === undefined ? {} : { genId }),
    ...(rewriteId === undefined ? {} : { rewriteId }),
    ...(role === undefined ? {} : { role }),
    ...chapter,
    ...(human === undefined ? {} : { human }),
    ...(syntheticEmpty === undefined ? {} : { syntheticEmpty }),
    revisionId: requireHash(node.revisionId, `${label}.revisionId`),
    ...(tokenProbabilityId === undefined ? {} : { tokenProbabilityId }),
    ...(generationRecordIds === undefined ? {} : { generationRecordIds }),
    ...(reasoningId === undefined ? {} : { reasoningId }),
    ...(imageAttachments === undefined ? {} : { imageAttachments }),
    ...(attribution === undefined ? {} : { attribution }),
    ...(rewrittenSpans === undefined ? {} : { rewrittenSpans }),
    activeChildId
  };
  if (syntheticEmpty === true && (
    stored.revisionId !== SYNTHETIC_EMPTY_REVISION_ID || stored.preview !== "" || stored.words !== 0
  )) throw new StoryFormatError(`${label}.syntheticEmpty must describe the canonical empty revision and stub`);
  return stored;
}

function parseTags(value: unknown, nodeIds: Set<string>): StoredTagV1[] {
  const seen = new Set<string>();
  let canonCount = 0;
  return arrayValue(value, "bookmarks").map((entry, index) => {
    const label = `bookmarks[${index}]`;
    const tag = recordValue(entry, label);
    const nodeId = stringField(tag, "nodeId");
    if (!nodeIds.has(nodeId)) throw new StoryFormatError(`${label}.nodeId references an unknown node`);
    if (seen.has(nodeId)) throw new StoryFormatError(`Duplicate tag node id: ${nodeId}`);
    seen.add(nodeId);
    const name = stringField(tag, "name");
    const nameLength = unicodeScalarLength(name, 80);
    if (nameLength < 1 || nameLength > 80 || name !== name.trim()) {
      throw new StoryFormatError(`${label}.name must be trimmed and contain 1–80 characters`);
    }
    const tagLabel = stringField(tag, "label");
    if (!isTagStatus(tagLabel)) throw new StoryFormatError(`${label}.label is invalid`);
    if (tagLabel === "Canon" && ++canonCount > 1) {
      throw new StoryFormatError("Only one tag may be Canon");
    }
    return {
      nodeId,
      name,
      label: tagLabel,
      color: stringField(tag, "color"),
      createdAt: stringField(tag, "createdAt")
    };
  });
}

function parseStoredBranches(value: unknown, base: readonly StoredPartV2[]): StoredBranchV1[] {
  const entries = arrayValue(value, "branches");
  if (entries.length > LEGACY_MAX_BRANCHES) throw new StoryFormatError("branches exceeds the 32-branch limit");
  const baseIds = new Set(base.map((part) => part.id));
  const ids = new Set<string>();
  let canonCount = 0;
  return entries.map((entry, index) => {
    const label = `branches[${index}]`;
    const branch = recordValue(entry, label);
    const id = stringField(branch, "id");
    if (ids.has(id)) throw new StoryFormatError(`Duplicate branch id: ${id}`);
    ids.add(id);
    const name = stringField(branch, "name");
    const nameLength = unicodeScalarLength(name, 80);
    if (nameLength < 1 || nameLength > 80 || name !== name.trim()) {
      throw new StoryFormatError(`${label}.name must be trimmed and contain 1–80 characters`);
    }
    const branchLabel = stringField(branch, "label");
    if (!isTagStatus(branchLabel)) throw new StoryFormatError(`${label}.label is invalid`);
    if (branch.canon !== undefined && branch.canon !== true) throw new StoryFormatError(`${label}.canon must be true or absent`);
    if (branch.canon === true && ++canonCount > 1) throw new StoryFormatError("Only one branch may be canon");
    const forkPartId = nullableString(branch.forkPartId, `${label}.forkPartId`);
    if (forkPartId !== null && !baseIds.has(forkPartId)) {
      throw new StoryFormatError(`${label}.forkPartId references an unknown base part`);
    }
    const forkOffset = branch.forkOffset;
    if (forkOffset !== null && (!Number.isSafeInteger(forkOffset) || (forkOffset as number) < 1)) {
      throw new StoryFormatError(`${label}.forkOffset must be null or an integer of at least 1`);
    }
    if (forkPartId === null && forkOffset !== null) throw new StoryFormatError(`${label}.forkOffset requires forkPartId`);
    const forkPartIndex = integerField(branch, "forkPartIndex");
    if (forkPartIndex < 0 || (forkPartIndex === 0) !== (forkPartId === null)) {
      throw new StoryFormatError(`${label}.forkPartIndex must be 0 iff forkPartId is null`);
    }
    return {
      id,
      name,
      color: stringField(branch, "color"),
      label: branchLabel,
      ...(branch.canon === true ? { canon: true as const } : {}),
      createdAt: stringField(branch, "createdAt"),
      forkPartId,
      forkOffset: forkOffset as number | null,
      forkPartIndex,
      parts: arrayField(branch, "parts").map((part, partIndex) => parseStoredPart(part, `${label}.parts[${partIndex}]`))
    };
  });
}

function parseActiveBranchId(value: unknown, branches: readonly StoredBranchV1[]): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !branches.some((branch) => branch.id === value)) {
    throw new StoryFormatError("activeBranchId references an unknown branch");
  }
  return value;
}

function parseActiveRootId(
  value: unknown,
  nodes: readonly StoredNodeV1[],
  byId: ReadonlyMap<string, StoredNodeV1>
): string | null {
  if (nodes.length === 0) {
    if (value !== null) throw new StoryFormatError("activeRootId must be null when nodes is empty");
    return null;
  }
  if (typeof value !== "string") throw new StoryFormatError("activeRootId must reference a root node");
  const root = byId.get(value);
  if (root === undefined || root.parentId !== null) throw new StoryFormatError("activeRootId must reference a root node");
  return value;
}

export function cloneAttribution(value: HumanEditAttribution | null): HumanEditAttribution | null {
  return value === null
    ? null
    : {
        source: "human",
        ranges: value.ranges.map((range) => ({ ...range })),
        ...(value.deletedCharacters === undefined ? {} : { deletedCharacters: value.deletedCharacters })
      };
}

export function cloneRewrittenSpans(value: readonly TextRange[] | undefined): TextRange[] | undefined {
  return value === undefined ? undefined : value.map((range) => ({ ...range }));
}

export function cloneGenerationRecordIds(value: readonly string[] | undefined): string[] | undefined {
  return value === undefined || value.length === 0 ? undefined : [...value];
}

function parseGenerationRecordIds(value: unknown, label: string): ObjectHash[] | undefined {
  if (value === undefined) return undefined;
  const ids = arrayValue(value, label);
  if (ids.length === 0) throw new StoryFormatError(`${label} must not be empty when present`);
  if (ids.length > MAX_GENERATION_RECORD_IDS) {
    throw new StoryFormatError(`${label} exceeds the ${MAX_GENERATION_RECORD_IDS}-record limit`);
  }
  return ids.map((id, index) => requireHash(id, `${label}[${index}]`));
}

function nullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") throw new StoryFormatError(`${label} must be a string or null`);
  return value;
}

function optionalTrue(value: unknown, label: string): true | undefined {
  if (value === undefined) return undefined;
  if (value !== true) throw new StoryFormatError(`${label} must be true or absent`);
  return true;
}

export function optionalRole(value: unknown, label: string): "summary" | undefined {
  if (value === undefined) return undefined;
  if (value !== "summary") throw new StoryFormatError(`${label} must be "summary"`);
  return value;
}

/** Parse one stored node's Image Attachments, independent of which schema
 *  version is on disk. It mirrors how `tokenProbabilityId` and `reasoningId`
 *  above are read the same way regardless of source version. A successor
 *  manifest's closed node shape already ran this check
 *  (`server/story-v7-strict.ts`); this call is what protects a legacy V2-V4
 *  source, which has no closed-shape pass of its own. */
function parseStoredImageAttachments(
  value: unknown,
  label: string
): readonly StoryImageAttachment[] | undefined {
  if (value === undefined) return undefined;
  try {
    assertStoryImageAttachments(value, label);
  } catch (error) {
    if (error instanceof ImageAttachmentError) throw new StoryFormatError(error.message);
    throw error;
  }
  return value;
}
