import { assertStoryImageAttachments, ImageAttachmentError } from "../shared/image-attachment.js";
import { StoryFormatError } from "./story-format-facts.js";
import {
  assertManifestCommonFields,
  assertNodeCommonFields,
  NODE,
  ROOT
} from "./story-v5-strict.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";

/** The successor node shape: every V5 stored-node key, plus one closed,
 * bounded, order-preserving list of Image Attachments. `NODE.required` and
 * `NODE.allowed` are read back rather than re-listed, so the two node shapes
 * cannot silently drift apart on every field they still share. */
const NODE7 = closedShape(
  [...NODE.required],
  [...NODE.allowed].filter((key) => !NODE.required.includes(key)).concat("imageAttachments")
);

function assertNodeV7(value: unknown, label: string): void {
  const node = closedRecord(value, label, NODE7);
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

/** Structural closure and resource bounds for the successor content payload.
 * Every manifest-root field means exactly what it means on the V5 shape
 * (`assertManifestCommonFields`); the successor only widens one node field.
 * The literal `7` below is `STORY_SUCCESSOR_SCHEMA_VERSION`
 * (`server/story-format.ts`) written out by hand, the same way
 * `assertStrictV5Manifest` writes `5` by hand: importing the named constant
 * back from `story-format.ts` would import that module from this one while
 * it is still importing this module, which Node's loader cannot resolve. */
export function assertStrictV7Manifest(
  value: unknown,
  expectedId: string,
  expectedFormat: "1667-story" | "storytavern-story" = "1667-story"
): asserts value is Record<string, unknown> {
  const manifest = closedRecord(value, `story ${expectedId} manifest`, ROOT);
  literal(manifest.format, expectedFormat, "manifest.format");
  literal(manifest.schemaVersion, 7, "manifest.schemaVersion");
  assertManifestCommonFields(manifest, expectedId, assertNodeV7);
}
