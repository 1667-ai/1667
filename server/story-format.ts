import { createHash } from "node:crypto";
import {
  type TagStatus,
  type ChapterBreak,
  type CoveredExtent,
  type HumanEditAttribution,
  type Story,
  type StoryNode,
  type StoryOrigin,
} from "../shared/types.js";
import type { FactActivation } from "../shared/fact-activation.js";
import { parseChapterBreaks, validateChapterRecords } from "./story-format-chapters.js";
import { assertWellFormedUnicode } from "./story-format-unicode.js";
import {
  HASH_PATTERN,
  StoryFormatError,
  arrayField,
  arrayValue,
  integerField,
  optionalString,
  parseVersionAttributions,
  recordValue,
  requireHash,
  stringField,
  validateVersionAttributions
} from "./story-format-facts.js";
import {
  convertV3ToV4,
  optionalRole,
  parseLegacyManifest,
  parseV4Manifest
} from "./story-format-nodes.js";
import { assertStrictV5Manifest, MAX_STORY_MANIFEST_BYTES } from "./story-v5-strict.js";

export { HASH_PATTERN, StoryFormatError, requireHash } from "./story-format-facts.js";
export { manifestRevisionIds } from "./story-format-nodes.js";
export { hasUnpairedSurrogate } from "./story-format-unicode.js";
export const STORY_FORMAT = "1667-story";
/** StoryTavern objects are content-addressed. Read their exact identifiers so
 * migration does not invalidate hashes; every new object uses 1667 instead. */
export const STORYTAVERN_STORY_FORMAT = "storytavern-story";
export const STORY_SCHEMA_VERSION = 5;
export const REVISION_FORMAT = "1667-text-revision";
export const STORYTAVERN_REVISION_FORMAT = "storytavern-text-revision";
export const REVISION_SCHEMA_VERSION = 1;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_CHUNKS_PER_REVISION = 65_536;
export type ObjectHash = string;
export interface StoredPartV2 {
  id: string;
  instruction: string;
  model: string;
  createdAt: string;
  genId?: string;
  role?: "summary";
  revisionIds: ObjectHash[];
  activeRevision: number;
  versionAttributions?: Array<HumanEditAttribution | null>;
}

export interface StoredFactV1 {
  id: string;
  tag: string | null;
  /** Optional in V5 manifests written before keyed activation existed. */
  activation?: FactActivation;
  /** Optional in V5 manifests written before fact keys existed. */
  keys?: string[];
  revisionId: ObjectHash;
  createdAt: string;
  updatedAt: string;
  sourcePartId?: string;
}

export interface StoryManifestV2 {
  format: typeof STORY_FORMAT;
  schemaVersion: 2;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: StoryOrigin;
  activeWordCount: number;
  parts: StoredPartV2[];
  facts: StoredFactV1[];
}

/** Legacy schemaVersion 1 shape. `label` keeps its original spelling: this
 * reads files already on disk, so the key cannot be renamed. */
export interface StoredBranchV1 {
  id: string;
  name: string;
  color: string;
  label: TagStatus;
  canon?: true;
  createdAt: string;
  forkPartId: string | null;
  forkOffset: number | null;
  forkPartIndex: number;
  parts: StoredPartV2[];
}

export interface StoryManifestV3 {
  format: typeof STORY_FORMAT;
  schemaVersion: 3;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: StoryOrigin;
  activeWordCount: number;
  parts: StoredPartV2[];
  facts: StoredFactV1[];
  branches: StoredBranchV1[];
  activeBranchId: string | null;
}

export interface StoredNodeV1 {
  id: string;
  parentId: string | null;
  instruction: string;
  model: string;
  createdAt: string;
  /** Optional on early V4 bundles; populated on their next save. */
  preview?: string;
  words?: number;
  tokens?: number;
  updatedAt?: string;
  genId?: string;
  /** Internal idempotency marker for a committed selection rewrite. */
  rewriteId?: string;
  role?: "summary";
  chapterBreakId?: string;
  coveredExtent?: CoveredExtent;
  madeAt?: string;
  editedByUser?: true;
  human?: true;
  /** Transitional V3 migration endpoint. Its empty revision is materialized on
   * the first V4 save, so loading does not require that object to exist yet. */
  syntheticEmpty?: true;
  revisionId: ObjectHash;
  attribution?: HumanEditAttribution | null;
  activeChildId: string | null;
}

/** The stored shape of a tag. `label` is the on-disk key and keeps its original
 * spelling: this interface is serialized straight to JSON, so renaming the field
 * would rename the key and orphan every story already written. `Tag.status` is
 * the in-memory name; `story-codec.ts` maps between the two. */
export interface StoredTagV1 {
  nodeId: string;
  name: string;
  label: TagStatus;
  color: string;
  createdAt: string;
}

export interface StoryManifestV4 {
  format: typeof STORY_FORMAT;
  schemaVersion: 4;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  origin?: StoryOrigin;
  activeWordCount: number;
  nodes: StoredNodeV1[];
  facts: StoredFactV1[];
  activeRootId: string | null;
  /** On-disk key, kept for the reason given on `StoredTagV1`. */
  bookmarks: StoredTagV1[];
  recentNodeIds: string[];
}

export interface StoryManifestV5 extends Omit<StoryManifestV4, "schemaVersion"> {
  schemaVersion: typeof STORY_SCHEMA_VERSION;
  authorsNote?: string;
  /** Story-scoped override of `writing.defaultAuthorBrief`; absent falls back
   *  to the machine-wide value. See `resolveAuthorBrief`. */
  authorBrief?: string;
  /** Internal idempotency marker for a committed generated title. */
  autonameId?: string;
  /** Chapter one's name. It has no opening break to carry one. */
  firstChapterTitle?: string;
  chapterBreaks: ChapterBreak[];
}

export interface TextRevisionV1 {
  format: typeof REVISION_FORMAT | typeof STORYTAVERN_REVISION_FORMAT;
  schemaVersion: typeof REVISION_SCHEMA_VERSION;
  chunks: ObjectHash[];
  utf16Length: number;
}

export function sha256(bytes: string | Uint8Array): ObjectHash {
  return createHash("sha256").update(bytes).digest("hex");
}

export function chunkId(text: string): ObjectHash {
  return sha256(Buffer.from(text, "utf8"));
}

/** Split at stable prose boundaries while preserving every character exactly. */
export function chunkText(text: string): string[] {
  assertWellFormedUnicode(text);
  if (text.length === 0) return [];
  const chunks: string[] = [];
  const separator = /(?:\r\n|\r|\n)(?:[\t ]*(?:\r\n|\r|\n))+/g;
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const end = match.index + match[0].length;
    appendParagraphChunks(chunks, text.slice(start, end));
    start = end;
  }
  if (start < text.length) appendParagraphChunks(chunks, text.slice(start));

  if (chunks.join("") !== text) throw new StoryFormatError("Internal chunking error: text changed");
  if (chunks.some((chunk) => Buffer.byteLength(chunk, "utf8") > MAX_CHUNK_BYTES)) {
    throw new StoryFormatError("Internal chunking error: oversized chunk");
  }
  return chunks;
}

function appendParagraphChunks(chunks: string[], paragraph: string): void {
  for (const chunk of splitOversizedParagraph(paragraph)) {
    if (chunks.length >= MAX_CHUNKS_PER_REVISION) {
      throw new StoryFormatError(`Story text exceeds the ${MAX_CHUNKS_PER_REVISION.toLocaleString()}-chunk limit`);
    }
    chunks.push(chunk);
  }
}

function splitOversizedParagraph(paragraph: string): string[] {
  if (Buffer.byteLength(paragraph, "utf8") <= MAX_CHUNK_BYTES) return [paragraph];
  const spans: string[] = [];
  const anchor = /(?:\r\n|\r|\n)|(?:[.!?…]+["'’”)\]]*[\t ]+)/gu;
  let start = 0;
  for (const match of paragraph.matchAll(anchor)) {
    const end = match.index + match[0].length;
    spans.push(paragraph.slice(start, end));
    start = end;
  }
  if (start < paragraph.length) spans.push(paragraph.slice(start));
  return spans.flatMap((span) => splitOversizedSpan(span));
}

function splitOversizedSpan(span: string): string[] {
  if (Buffer.byteLength(span, "utf8") <= MAX_CHUNK_BYTES) return [span];
  const chunks: string[] = [];
  let start = 0;
  while (start < span.length) {
    let cursor = start;
    let bytes = 0;
    let lastWhitespace = -1;
    while (cursor < span.length) {
      const codePoint = span.codePointAt(cursor);
      if (codePoint === undefined) break;
      const value = String.fromCodePoint(codePoint);
      const nextBytes = Buffer.byteLength(value, "utf8");
      if (bytes + nextBytes > MAX_CHUNK_BYTES) break;
      bytes += nextBytes;
      cursor += value.length;
      if (/\s/u.test(value)) lastWhitespace = cursor;
    }
    if (cursor === span.length) {
      chunks.push(span.slice(start));
      break;
    }
    const end = lastWhitespace > start ? lastWhitespace : cursor;
    if (end <= start) throw new StoryFormatError("Unable to split oversized text safely");
    chunks.push(span.slice(start, end));
    start = end;
  }
  return chunks;
}

export function createRevision(chunks: readonly ObjectHash[], utf16Length: number): TextRevisionV1 {
  if (chunks.length > MAX_CHUNKS_PER_REVISION) {
    throw new StoryFormatError(`Revision exceeds the ${MAX_CHUNKS_PER_REVISION.toLocaleString()}-chunk limit`);
  }
  return {
    format: REVISION_FORMAT,
    schemaVersion: REVISION_SCHEMA_VERSION,
    chunks: [...chunks],
    utf16Length
  };
}

export function serializeRevision(revision: TextRevisionV1): string {
  return JSON.stringify({
    format: revision.format,
    schemaVersion: revision.schemaVersion,
    chunks: revision.chunks,
    utf16Length: revision.utf16Length
  });
}

export function revisionId(revision: TextRevisionV1): ObjectHash {
  return sha256(Buffer.from(serializeRevision(revision), "utf8"));
}

export function serializeManifest(manifest: StoryManifestV5): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseManifest(raw: string, expectedId: string): StoryManifestV5 {
  return parseManifestWithVersion(raw, expectedId).manifest;
}

export interface ParsedManifestVersion {
  manifest: StoryManifestV5;
  sourceSchemaVersion: 2 | 3 | 4 | typeof STORY_SCHEMA_VERSION;
}

/** Parse and normalize while retaining the on-disk version for migration-only
 * maintenance that cannot be inferred after old fact states collapse. */
export function parseManifestWithVersion(raw: string, expectedId: string): ParsedManifestVersion {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORY_MANIFEST_BYTES) {
    throw manifestSizeError();
  }
  return parseManifestValueWithVersion(parseJsonObject(raw, `story ${expectedId} manifest`), expectedId);
}

/** Preserve the historical unbounded V2-V4 read contract. Callers must first
 * stream-discriminate the top-level version so strict manifests stay bounded. */
export function parseLegacyManifestWithoutSizeLimit(raw: string, expectedId: string): ParsedManifestVersion {
  const value = parseJsonObject(raw, `story ${expectedId} manifest`);
  if (value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4) {
    throw manifestSizeError();
  }
  return parseManifestValueWithVersion(value, expectedId);
}

export function parseManifestValueWithVersion(input: unknown, expectedId: string): ParsedManifestVersion {
  const value = recordValue(input, `story ${expectedId} manifest`);
  if (
    !isSupportedStoryFormat(value.format)
    || (
      value.schemaVersion !== 2
      && value.schemaVersion !== 3
      && value.schemaVersion !== 4
      && value.schemaVersion !== STORY_SCHEMA_VERSION
    )
  ) {
    throw new StoryFormatError(`Unsupported story format in ${expectedId}`);
  }
  if (value.schemaVersion === STORY_SCHEMA_VERSION) {
    assertStrictV5Manifest(value, expectedId, value.format);
  }
  const id = stringField(value, "id");
  if (id !== expectedId) throw new StoryFormatError(`Story id mismatch: expected ${expectedId}, found ${id}`);
  const origin = optionalOrigin(value.origin);
  const sourceSchemaVersion = value.schemaVersion;
  const stored = sourceSchemaVersion === 2 || sourceSchemaVersion === 3
    ? convertV3ToV4(parseLegacyManifest(value))
    : parseV4Manifest(value);
  const chapterBreaks = sourceSchemaVersion === STORY_SCHEMA_VERSION
    ? parseChapterBreaks(value.chapterBreaks)
    : [];
  const autonameId = sourceSchemaVersion === STORY_SCHEMA_VERSION
    ? optionalString(value.autonameId, "autonameId")
    : undefined;
  // Chapter one's name. Older schema versions predate it, and an empty name is
  // an absent one, so it never survives as a field that means nothing.
  const firstChapterTitle = sourceSchemaVersion === STORY_SCHEMA_VERSION
    ? optionalString(value.firstChapterTitle, "firstChapterTitle")
    : undefined;
  const authorsNote = sourceSchemaVersion === STORY_SCHEMA_VERSION
    ? optionalString(value.authorsNote, "authorsNote")
    : undefined;
  const authorBrief = sourceSchemaVersion === STORY_SCHEMA_VERSION
    ? optionalString(value.authorBrief, "authorBrief")
    : undefined;
  validateChapterRecords(chapterBreaks, stored.nodes);
  const parsed: StoryManifestV5 = {
    ...stored,
    schemaVersion: STORY_SCHEMA_VERSION,
    ...(autonameId === undefined ? {} : { autonameId }),
    ...(firstChapterTitle === undefined || firstChapterTitle === ""
      ? {}
      : { firstChapterTitle }),
    ...(authorsNote === undefined || authorsNote === ""
      ? {}
      : { authorsNote }),
    ...(authorBrief === undefined || authorBrief === ""
      ? {}
      : { authorBrief }),
    chapterBreaks
  };
  return {
    manifest: origin === undefined ? parsed : { ...parsed, origin },
    sourceSchemaVersion
  };
}

export function parseRevision(raw: string, expectedHash: ObjectHash): TextRevisionV1 {
  requireHash(expectedHash, "revision id");
  if (sha256(Buffer.from(raw, "utf8")) !== expectedHash) {
    throw new StoryFormatError(`Revision hash mismatch: ${expectedHash}`);
  }
  const value = parseJsonObject(raw, `revision ${expectedHash}`);
  if (!isSupportedRevisionFormat(value.format)
    || value.schemaVersion !== REVISION_SCHEMA_VERSION) {
    throw new StoryFormatError(`Unsupported revision format: ${expectedHash}`);
  }
  const chunks = arrayField(value, "chunks").map((hash, index) => requireHash(hash, `chunks[${index}]`));
  if (chunks.length > MAX_CHUNKS_PER_REVISION) {
    throw new StoryFormatError(`Revision exceeds the ${MAX_CHUNKS_PER_REVISION.toLocaleString()}-chunk limit`);
  }
  const utf16Length = integerField(value, "utf16Length");
  if (utf16Length < 0) throw new StoryFormatError("utf16Length must not be negative");
  const revision: TextRevisionV1 = {
    ...createRevision(chunks, utf16Length),
    format: value.format
  };
  if (serializeRevision(revision) !== raw) throw new StoryFormatError(`Revision is not canonically serialized: ${expectedHash}`);
  return revision;
}

function isSupportedStoryFormat(
  value: unknown
): value is typeof STORY_FORMAT | typeof STORYTAVERN_STORY_FORMAT {
  return value === STORY_FORMAT || value === STORYTAVERN_STORY_FORMAT;
}

function isSupportedRevisionFormat(
  value: unknown
): value is typeof REVISION_FORMAT | typeof STORYTAVERN_REVISION_FORMAT {
  return value === REVISION_FORMAT || value === STORYTAVERN_REVISION_FORMAT;
}

export function parseLegacyStory(raw: string, expectedId: string): Story {
  const value = parseJsonObject(raw, `legacy story ${expectedId}`);
  if ("format" in value || "schemaVersion" in value) {
    throw new StoryFormatError(`Unsupported story schema in ${expectedId}`);
  }
  const id = stringField(value, "id");
  if (id !== expectedId) throw new StoryFormatError(`Story id mismatch: expected ${expectedId}, found ${id}`);
  const parts = arrayField(value, "parts").map((part, index) => parseLegacyPart(part, index));
  const origin = optionalOrigin(value.origin);
  const nodes = legacyNodes(parts);
  return {
    id,
    title: stringField(value, "title"),
    createdAt: stringField(value, "createdAt"),
    updatedAt: stringField(value, "updatedAt"),
    ...(origin === undefined ? {} : { origin }),
    nodes,
    activeRootId: parts[0]?.id ?? null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

export function validateNodeAttribution(node: StoryNode): void {
  validateVersionAttributions(
    node.id,
    node.attribution === undefined ? undefined : [node.attribution],
    [node.text]
  );
}

interface LegacyPart {
  id: string;
  instruction: string;
  text: string;
  model: string;
  createdAt: string;
  versions?: string[];
  activeVersion?: number;
  versionAttributions?: Array<HumanEditAttribution | null>;
  genId?: string;
  role?: "summary";
}

function parseLegacyPart(value: unknown, index: number): LegacyPart {
  const part = recordValue(value, `parts[${index}]`);
  const versionsValue = part.versions;
  let versions: string[] | undefined;
  if (versionsValue !== undefined) {
    versions = arrayValue(versionsValue, `parts[${index}].versions`).map((version, versionIndex) => {
      if (typeof version !== "string") throw new StoryFormatError(`parts[${index}].versions[${versionIndex}] must be a string`);
      return version;
    });
  }
  const activeVersion = part.activeVersion;
  const genId = optionalString(part.genId, `parts[${index}].genId`);
  const role = optionalRole(part.role, `parts[${index}].role`);
  const text = stringField(part, "text");
  const textCount = versions?.length ?? 1;
  const versionAttributions = parseVersionAttributions(
    part.versionAttributions,
    `parts[${index}].versionAttributions`,
    textCount
  );
  const result: LegacyPart = {
    id: stringField(part, "id"),
    instruction: stringField(part, "instruction"),
    text,
    model: stringField(part, "model"),
    createdAt: stringField(part, "createdAt"),
    ...(versions === undefined ? {} : { versions }),
    ...(activeVersion === undefined ? {} : { activeVersion: parseLegacyActiveVersion(activeVersion, `parts[${index}].activeVersion`) }),
    ...(versionAttributions === undefined ? {} : { versionAttributions }),
    ...(genId === undefined ? {} : { genId }),
    ...(role === undefined ? {} : { role })
  };
  legacyTexts(result);
  return result;
}

function legacyNodes(parts: readonly LegacyPart[]): StoryNode[] {
  const nodes: StoryNode[] = [];
  let parentId: string | null = null;
  let activeParent: StoryNode | null = null;
  for (const part of parts) {
    const { texts, active } = legacyTexts(part);
    const group = texts.map((text, index): StoryNode => ({
      id: index === active ? part.id : `${part.id}@v${index}`,
      parentId,
      instruction: part.instruction,
      text,
      model: part.model,
      createdAt: part.createdAt,
      ...(part.versionAttributions?.[index] === undefined ? {} : { attribution: part.versionAttributions[index] }),
      ...(part.genId === undefined ? {} : { genId: part.genId }),
      ...(part.role === undefined ? {} : { role: part.role }),
      activeChildId: null
    }));
    nodes.push(...group);
    const activeNode = group[active]!;
    if (activeParent !== null) activeParent.activeChildId = activeNode.id;
    activeParent = activeNode;
    parentId = activeNode.id;
  }
  return nodes;
}

function legacyTexts(part: LegacyPart): { texts: string[]; active: number } {
  if (part.versions === undefined) {
    if (part.activeVersion !== undefined) throw new StoryFormatError(`Part ${part.id} has activeVersion without versions`);
    validateVersionAttributions(part.id, part.versionAttributions, [part.text]);
    return { texts: [part.text], active: 0 };
  }
  if (part.versions.length === 0 || part.versions.length > 10) {
    throw new StoryFormatError(`Part ${part.id} has an invalid versions array`);
  }
  const active = part.activeVersion;
  if (active === undefined || active < 0 || active >= part.versions.length) {
    throw new StoryFormatError(`Part ${part.id} has an invalid activeVersion`);
  }
  if (part.versions[active] !== part.text) throw new StoryFormatError(`Part ${part.id} text does not match its active version`);
  validateVersionAttributions(part.id, part.versionAttributions, part.versions);
  return { texts: part.versions, active };
}

function parseLegacyActiveVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new StoryFormatError(`${label} must be an integer`);
  return value as number;
}

function optionalOrigin(value: unknown): StoryOrigin | undefined {
  if (value === undefined) return undefined;
  const origin = recordValue(value, "origin");
  const offset = origin.offset;
  if (offset !== null && (!Number.isInteger(offset) || (offset as number) < 0)) {
    throw new StoryFormatError("origin.offset must be null or a non-negative integer");
  }
  return {
    storyId: stringField(origin, "storyId"),
    storyTitle: stringField(origin, "storyTitle"),
    partId: stringField(origin, "partId"),
    offset: offset as number | null,
    createdAt: stringField(origin, "createdAt")
  };
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    return recordValue(JSON.parse(raw) as unknown, label);
  } catch (error) {
    if (error instanceof StoryFormatError) throw error;
    throw new StoryFormatError(`Invalid JSON in ${label}`, { cause: error });
  }
}

function manifestSizeError(): StoryFormatError {
  return new StoryFormatError(`Story manifest exceeds its ${MAX_STORY_MANIFEST_BYTES}-byte size limit`);
}
