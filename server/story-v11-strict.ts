import { HASH_PATTERN, StoryFormatError } from "./story-format-facts.js";
import {
  assertManifestCommonFields,
  assertNodeCommonFields,
  identifier,
  NODE
} from "./story-v5-strict.js";
import { assertStoryImageAttachments } from "../shared/image-attachment.js";
import { unicodeScalarLength } from "../shared/unicode.js";
import { closedRecord, closedShape, literal, safeInteger } from "./story-wire-validation.js";

const NODE11 = closedShape(
  [...NODE.required],
  [...NODE.allowed].filter((key) => !NODE.required.includes(key)).concat("imageAttachments")
);

const ROOT11 = closedShape(
  ["format", "schemaVersion", "id", "title", "createdAt", "updatedAt", "activeWordCount", "nodes", "facts",
    "activeRootId", "bookmarks", "recentNodeIds", "chapterBreaks", "asideDocumentId",
    "asideSessionRefs", "asideUnanchoredSessionRefs"],
  ["origin", "authorsNote", "authorsNoteDepth", "authorBrief", "phraseBias", "bannedStrings", "autonameId",
    "firstChapterTitle", "factsBudgetTokens"]
);

const REF = closedShape(
  ["id", "documentId", "anchor", "turnCount"],
  ["originAnchor", "sourceAsideDocumentId"]
);
const ANCHOR = closedShape(["partId", "takeId"]);
/** Maximum refs in either persisted session bucket. */
export const MAX_SESSION_REFS_PER_BUCKET = 10_000;
const MAX_SESSION_TURNS = 100;

/** Validate the V11 content payload while leaving the V9 payload unchanged. */
export function assertStrictV11Manifest(
  value: unknown,
  expectedId: string,
  expectedFormat: "1667-story" | "storytavern-story" = "1667-story"
): asserts value is Record<string, unknown> {
  const manifest = closedRecord(value, `story ${expectedId} manifest`, ROOT11);
  literal(manifest.format, expectedFormat, "manifest.format");
  literal(manifest.schemaVersion, 11, "manifest.schemaVersion");
  assertManifestCommonFields(manifest, expectedId, assertNodeV11);
  if (manifest.asideDocumentId !== null
    && (typeof manifest.asideDocumentId !== "string" || !HASH_PATTERN.test(manifest.asideDocumentId))) {
    throw new StoryFormatError("manifest.asideDocumentId must be a SHA-256 hex digest or null");
  }
  const anchored = parseRefs(manifest.asideSessionRefs, "manifest.asideSessionRefs", false);
  const unanchored = parseRefs(manifest.asideUnanchoredSessionRefs, "manifest.asideUnanchoredSessionRefs", true);
  const ids = new Set<string>();
  for (const ref of [...anchored, ...unanchored]) {
    if (ids.has(ref.id as string)) throw new StoryFormatError(`Duplicate Aside session id: ${ref.id}`);
    ids.add(ref.id as string);
  }
}

function assertNodeV11(value: unknown, label: string): void {
  const node = closedRecord(value, label, NODE11);
  assertNodeCommonFields(node, label);
  if (node.imageAttachments !== undefined) {
    try {
      assertStoryImageAttachments(node.imageAttachments, `${label}.imageAttachments`);
    } catch (error) {
      if (error instanceof Error) throw new StoryFormatError(error.message);
      throw error;
    }
  }
}

function parseRefs(value: unknown, label: string, unanchored: boolean): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new StoryFormatError(`${label} must be an array`);
  if (value.length > MAX_SESSION_REFS_PER_BUCKET) {
    throw new StoryFormatError(`${label} exceeds ${MAX_SESSION_REFS_PER_BUCKET}`);
  }
  return value.map((entry, index) => {
    const ref = closedRecord(entry, `${label}[${index}]`, REF);
    if (typeof ref.id !== "string" || ref.id.length === 0
      || unicodeScalarLength(ref.id, 129) > 128) {
      throw new StoryFormatError(`${label}[${index}].id must be a non-empty session id`);
    }
    if (typeof ref.documentId !== "string" || !HASH_PATTERN.test(ref.documentId)) {
      throw new StoryFormatError(`${label}[${index}].documentId must be a SHA-256 hex digest`);
    }
    if (ref.sourceAsideDocumentId !== undefined
      && (typeof ref.sourceAsideDocumentId !== "string"
        || !HASH_PATTERN.test(ref.sourceAsideDocumentId))) {
      throw new StoryFormatError(
        `${label}[${index}].sourceAsideDocumentId must be a SHA-256 hex digest`
      );
    }
    const turnCount = safeInteger(ref.turnCount, `${label}[${index}].turnCount`, { min: 0, max: MAX_SESSION_TURNS });
    if (unanchored) {
      if (ref.anchor !== null) throw new StoryFormatError(`${label}[${index}].anchor must be null`);
    } else {
      assertAnchor(ref.anchor, `${label}[${index}].anchor`);
    }
    if (ref.originAnchor !== undefined && ref.originAnchor !== null) {
      assertAnchor(ref.originAnchor, `${label}[${index}].originAnchor`);
    }
    return { ...ref, turnCount };
  });
}

function assertAnchor(value: unknown, label: string): void {
  const anchor = closedRecord(value, label, ANCHOR);
  identifier(anchor.partId, `${label}.partId`);
  identifier(anchor.takeId, `${label}.takeId`);
}
