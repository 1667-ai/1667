import { assertStoryImageAttachments, ImageAttachmentError } from "../shared/image-attachment.js";
import { HASH_PATTERN, StoryFormatError } from "./story-format-facts.js";
import {
  assertManifestCommonFields,
  assertNodeCommonFields,
  NODE,
  ROOT
} from "./story-v5-strict.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";

/** V9 node shape matches V7: every V5 stored-node key, plus optional
 * imageAttachments. */
const NODE9 = closedShape(
  [...NODE.required],
  [...NODE.allowed].filter((key) => !NODE.required.includes(key)).concat("imageAttachments")
);

/** V9 root: every V5/V7 root field, plus required nullable asideDocumentId. */
const ROOT9 = closedShape(
  [...ROOT.required, "asideDocumentId"],
  [...ROOT.allowed].filter((key) => !ROOT.required.includes(key))
);

function assertNodeV9(value: unknown, label: string): void {
  const node = closedRecord(value, label, NODE9);
  assertNodeCommonFields(node, label);
  if (node.imageAttachments !== undefined) {
    try {
      assertStoryImageAttachments(node.imageAttachments, `${label}.imageAttachments`);
    } catch (error) {
      if (error instanceof ImageAttachmentError) throw new StoryFormatError(error.message);
      throw error;
    }
  }
}

/**
 * Structural closure for the Aside content payload (schemaVersion 9).
 * The literal `9` is `STORY_ASIDE_SCHEMA_VERSION` written by hand to avoid a
 * circular import with `story-format.ts`, matching `assertStrictV7Manifest`.
 */
export function assertStrictV9Manifest(
  value: unknown,
  expectedId: string,
  expectedFormat: "1667-story" | "storytavern-story" = "1667-story"
): asserts value is Record<string, unknown> {
  const manifest = closedRecord(value, `story ${expectedId} manifest`, ROOT9);
  literal(manifest.format, expectedFormat, "manifest.format");
  literal(manifest.schemaVersion, 9, "manifest.schemaVersion");
  assertManifestCommonFields(manifest, expectedId, assertNodeV9);
  if (manifest.asideDocumentId === null) return;
  if (typeof manifest.asideDocumentId !== "string" || !HASH_PATTERN.test(manifest.asideDocumentId)) {
    throw new StoryFormatError("manifest.asideDocumentId must be a SHA-256 hex digest or null");
  }
}
