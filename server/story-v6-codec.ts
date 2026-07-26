import type { StorySummary } from "../shared/types.js";
import { assertNfcJsonStrings, canonicalJson, decodeCanonicalUtf8, encodeUtf8Strict } from "./canonical-json.js";
import { HASH_PATTERN, StoryFormatError } from "./story-format-facts.js";
import {
  parseLegacyManifestWithoutSizeLimit,
  parseManifestValueWithVersion,
  STORY_FORMAT,
  STORYTAVERN_STORY_FORMAT
} from "./story-format.js";
import { hasLegacyTopLevelSchemaVersion } from "./json-schema-version.js";
import { buildStorySummary } from "./story-summary.js";
import {
  MAX_STORY_MANIFEST_BYTES,
  MAX_STORY_TITLE_CHARS,
  requireStoryId
} from "./story-v5-strict.js";
import type {
  DeletedStoryManifestV6,
  Hash256,
  LiveStoryManifestV6,
  MutationId,
  ParsedStoryManifest,
  PreparedUserTransactionPointer,
  ProviderPointer,
  Revision20,
  StoryManifestV6,
  StorySummaryV6,
  TimeMs,
  UInt64String,
  UserTransactionPointer
} from "./story-v6-types.js";
import {
  boundedString,
  closedRecord,
  closedShape,
  literal,
  safeInteger
} from "./story-wire-validation.js";
import {
  DECIMAL_20_PATTERN,
  REVISION_ONE,
  TIME_MS_PATTERN,
  UINT64_MAX,
  V6_MUTATION_ID_PATTERN
} from "./story-v6-scalars.js";

export const MAX_DELETED_STORY_MANIFEST_BYTES = 64 * 1024;
export const STORY_SCHEMA_VERSION_V6 = 6;

const LIVE = closedShape([
  "format", "schemaVersion", "kind", "id", "revision", "previousManifestHash", "content", "summary",
  "unresolvedProvider", "lastTransaction"
]);
const DELETED = closedShape([
  "format", "schemaVersion", "kind", "id", "revision", "previousManifestHash", "deletedAt",
  "unresolvedProvider", "lastTransaction"
]);
const SUMMARY = closedShape(["id", "title", "updatedAt", "partCount", "words", "forked", "lineCount"]);
const PROVIDER_POINTER = closedShape(["mutationId", "fingerprintHash"]);
const TRANSACTION_POINTER = closedShape(["receiptKind", "mutationId", "phase"]);

export function parseStoryManifestBytes(bytes: Uint8Array, expectedId: string): ParsedStoryManifest {
  if (bytes.byteLength > MAX_STORY_MANIFEST_BYTES) {
    throw new StoryFormatError(`Story manifest exceeds its ${MAX_STORY_MANIFEST_BYTES}-byte size limit`);
  }
  let text: string;
  try {
    text = decodeCanonicalUtf8(bytes, `story ${expectedId} manifest`);
  } catch (error) {
    if (!hasLegacyTopLevelSchemaVersion(bytes)) throw error;
    const parsed = parseLegacyManifestWithoutSizeLimit(Buffer.from(bytes).toString("utf8"), expectedId);
    return { kind: "v5", manifest: parsed.manifest, sourceSchemaVersion: parsed.sourceSchemaVersion };
  }
  const value = parseJson(text, expectedId);
  if (!isV6Candidate(value)) {
    const parsed = parseManifestValueWithVersion(value, expectedId);
    return { kind: "v5", manifest: parsed.manifest, sourceSchemaVersion: parsed.sourceSchemaVersion };
  }
  if (value.kind === "deleted" && bytes.byteLength > MAX_DELETED_STORY_MANIFEST_BYTES) {
    throw new StoryFormatError(
      `Deleted story manifest exceeds its ${MAX_DELETED_STORY_MANIFEST_BYTES}-byte size limit`
    );
  }
  const manifest = parseV6(value, expectedId);
  assertNfcJsonStrings(value, `story ${expectedId} manifest`);
  if (canonicalJson(value) !== text) throw new StoryFormatError(`Story ${expectedId} V6 manifest is not canonical JSON`);
  return manifest.kind === "live"
    ? { kind: "v6-live", manifest }
    : { kind: "v6-deleted", manifest };
}

export function parseStoryManifestText(text: string, expectedId: string): ParsedStoryManifest {
  return parseStoryManifestBytes(encodeUtf8Strict(text, `story ${expectedId} manifest`), expectedId);
}

export function formatV6(manifest: StoryManifestV6): string {
  const text = canonicalJson(manifest);
  const parsed = parseStoryManifestText(text, manifest.id);
  if (parsed.kind === "v5") throw new StoryFormatError("Expected a V6 story manifest");
  return text;
}

export function storySummaryFromV6(manifest: LiveStoryManifestV6): StorySummary {
  const words = safeSummaryNumber(manifest.summary.words, "summary.words");
  const lineCount = safeSummaryNumber(manifest.summary.lineCount, "summary.lineCount");
  return {
    id: manifest.summary.id,
    title: manifest.summary.title,
    updatedAt: manifest.summary.updatedAt,
    partCount: manifest.summary.partCount,
    words,
    forked: manifest.summary.forked,
    lineCount
  };
}

export function storySummaryV6FromContent(
  content: LiveStoryManifestV6["content"]
): StorySummaryV6 {
  const summary = buildStorySummary(content);
  return {
    id: summary.id,
    title: summary.title,
    updatedAt: summary.updatedAt,
    partCount: summary.partCount,
    words: formatUInt64(summary.words),
    forked: summary.forked,
    lineCount: formatUInt64(summary.lineCount)
  };
}

function parseV6(value: Record<string, unknown>, expectedId: string): StoryManifestV6 {
  if (value.kind === "live") return parseLive(value, expectedId);
  if (value.kind === "deleted") return parseDeleted(value, expectedId);
  throw new StoryFormatError(`Story ${expectedId} V6 kind must be live or deleted`);
}

function parseLive(value: unknown, expectedId: string): LiveStoryManifestV6 {
  const manifest = closedRecord(value, `story ${expectedId} V6 live manifest`, LIVE);
  parseCommonLiterals(manifest);
  literal(manifest.kind, "live", "manifest.kind");
  const id = matchedStoryId(manifest.id, expectedId);
  const revision = revision20(manifest.revision, "manifest.revision");
  const previousManifestHash = nullableHash(manifest.previousManifestHash, "manifest.previousManifestHash");
  assertRevisionPredecessor(revision, previousManifestHash);
  const content = parseManifestValueWithVersion(manifest.content, id);
  if (content.sourceSchemaVersion !== 5) throw new StoryFormatError("V6 content must contain an exact V5 payload");
  const summary = parseStorySummaryV6(manifest.summary);
  const unresolvedProvider = nullableProviderPointer(manifest.unresolvedProvider);
  const lastTransaction = nullableTransactionPointer(manifest.lastTransaction);
  if (lastTransaction?.phase === "started" && (
    unresolvedProvider === null || unresolvedProvider.mutationId !== lastTransaction.mutationId
  )) {
    throw new StoryFormatError("A started story transaction must match unresolvedProvider");
  }
  const parsed: LiveStoryManifestV6 = {
    format: "1667-story",
    schemaVersion: STORY_SCHEMA_VERSION_V6,
    kind: "live",
    id,
    revision,
    previousManifestHash,
    content: content.manifest,
    summary,
    unresolvedProvider,
    lastTransaction
  };
  assertSummaryMatchesContent(parsed);
  return parsed;
}

function parseDeleted(value: unknown, expectedId: string): DeletedStoryManifestV6 {
  const manifest = closedRecord(value, `story ${expectedId} V6 deleted manifest`, DELETED);
  parseCommonLiterals(manifest);
  literal(manifest.kind, "deleted", "manifest.kind");
  const id = matchedStoryId(manifest.id, expectedId);
  const revision = revision20(manifest.revision, "manifest.revision");
  const previousManifestHash = hash256(manifest.previousManifestHash, "manifest.previousManifestHash");
  if (revision === REVISION_ONE) throw new StoryFormatError("Deleted story revision must be greater than 1");
  return {
    format: "1667-story",
    schemaVersion: STORY_SCHEMA_VERSION_V6,
    kind: "deleted",
    id,
    revision,
    previousManifestHash,
    deletedAt: timeMs(manifest.deletedAt, "manifest.deletedAt"),
    unresolvedProvider: nullableProviderPointer(manifest.unresolvedProvider),
    lastTransaction: preparedTransactionPointer(manifest.lastTransaction)
  };
}

function parseCommonLiterals(manifest: Record<string, unknown>): void {
  if (manifest.format !== STORY_FORMAT
    && manifest.format !== STORYTAVERN_STORY_FORMAT) {
    throw new StoryFormatError("manifest.format is invalid");
  }
  literal(manifest.schemaVersion, STORY_SCHEMA_VERSION_V6, "manifest.schemaVersion");
}

export function parseStorySummaryV6(value: unknown, label = "manifest.summary"): StorySummaryV6 {
  const summary = closedRecord(value, label, SUMMARY);
  if (typeof summary.forked !== "boolean") throw new StoryFormatError(`${label}.forked must be a boolean`);
  return {
    id: requireStoryId(summary.id, `${label}.id`),
    title: boundedString(summary.title, `${label}.title`, MAX_STORY_TITLE_CHARS),
    updatedAt: timeMs(summary.updatedAt, `${label}.updatedAt`),
    partCount: safeInteger(summary.partCount, `${label}.partCount`, { min: 0, max: 0xffff_ffff }),
    words: uint64String(summary.words, `${label}.words`, true),
    forked: summary.forked,
    lineCount: uint64String(summary.lineCount, `${label}.lineCount`, true)
  };
}

function parseProviderPointer(value: unknown): ProviderPointer {
  const pointer = closedRecord(value, "manifest.unresolvedProvider", PROVIDER_POINTER);
  return {
    mutationId: mutationId(pointer.mutationId, "manifest.unresolvedProvider.mutationId"),
    fingerprintHash: hash256(pointer.fingerprintHash, "manifest.unresolvedProvider.fingerprintHash")
  };
}

function nullableProviderPointer(value: unknown): ProviderPointer | null {
  return value === null ? null : parseProviderPointer(value);
}

function parseTransactionPointer(value: unknown): UserTransactionPointer {
  const pointer = closedRecord(value, "manifest.lastTransaction", TRANSACTION_POINTER);
  literal(pointer.receiptKind, "user", "manifest.lastTransaction.receiptKind");
  const phase = pointer.phase;
  if (phase !== "started" && phase !== "prepared") {
    throw new StoryFormatError("manifest.lastTransaction.phase must be started or prepared");
  }
  return {
    receiptKind: "user",
    mutationId: mutationId(pointer.mutationId, "manifest.lastTransaction.mutationId"),
    phase
  };
}

function nullableTransactionPointer(value: unknown): UserTransactionPointer | null {
  return value === null ? null : parseTransactionPointer(value);
}

function preparedTransactionPointer(value: unknown): PreparedUserTransactionPointer {
  const pointer = parseTransactionPointer(value);
  if (pointer.phase !== "prepared") {
    throw new StoryFormatError("Deleted story lastTransaction must be prepared");
  }
  return pointer;
}

function assertSummaryMatchesContent(manifest: LiveStoryManifestV6): void {
  const expected = storySummaryV6FromContent(manifest.content);
  const actual = manifest.summary;
  if (
    actual.id !== manifest.id
    || manifest.content.id !== manifest.id
    || actual.title !== expected.title
    || actual.updatedAt !== expected.updatedAt
    || actual.partCount !== expected.partCount
    || actual.words !== expected.words
    || actual.forked !== expected.forked
    || actual.lineCount !== expected.lineCount
  ) throw new StoryFormatError("V6 summary does not match its content");
}

function assertRevisionPredecessor(revision: Revision20, previous: Hash256 | null): void {
  if ((revision === REVISION_ONE) !== (previous === null)) {
    throw new StoryFormatError("V6 revision 1 must have no predecessor and later revisions must have one");
  }
}

function matchedStoryId(value: unknown, expectedId: string): string {
  const id = requireStoryId(value, "manifest.id");
  if (id !== expectedId) throw new StoryFormatError(`Story id mismatch: expected ${expectedId}, found ${id}`);
  return id;
}

function hash256(value: unknown, label: string): Hash256 {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new StoryFormatError(`${label} is invalid`);
  return value;
}

function nullableHash(value: unknown, label: string): Hash256 | null {
  return value === null ? null : hash256(value, label);
}

function timeMs(value: unknown, label: string): TimeMs {
  if (typeof value !== "string" || !TIME_MS_PATTERN.test(value)) throw new StoryFormatError(`${label} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new StoryFormatError(`${label} is invalid`);
  return value;
}

function revision20(value: unknown, label: string): Revision20 {
  return uint64String(value, label, false);
}

function uint64String(value: unknown, label: string, allowZero: boolean): UInt64String {
  if (typeof value !== "string" || !DECIMAL_20_PATTERN.test(value)) throw new StoryFormatError(`${label} is invalid`);
  const integer = BigInt(value);
  if (integer > UINT64_MAX || (!allowZero && integer === 0n)) throw new StoryFormatError(`${label} is out of range`);
  return value;
}

function mutationId(value: unknown, label: string): MutationId {
  if (typeof value !== "string" || !V6_MUTATION_ID_PATTERN.test(value)) {
    throw new StoryFormatError(`${label} is invalid`);
  }
  return value;
}

function formatUInt64(value: number): UInt64String {
  if (!Number.isSafeInteger(value) || value < 0) throw new StoryFormatError("V5 summary count is out of range");
  return BigInt(value).toString().padStart(20, "0");
}

function safeSummaryNumber(value: UInt64String, label: string): number {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new StoryFormatError(`${label} exceeds the current API range`);
  return Number(parsed);
}

function parseJson(text: string, expectedId: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StoryFormatError(`Invalid JSON in story ${expectedId} manifest`, { cause: error });
  }
}

function isV6Candidate(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schemaVersion === STORY_SCHEMA_VERSION_V6;
}
