import { HASH_PATTERN, StoryFormatError } from "./story-format-facts.js";
import { assertStrictV13Manifest } from "./story-v13-strict.js";
import { literal } from "./story-wire-validation.js";

/** Strict V15 content validation. V15 is an additive successor: validate the
 * frozen V13 payload unchanged, then require the separate run pointer. */
export function assertStrictV15Manifest(
  value: unknown,
  expectedId: string,
  expectedFormat: "1667-story" | "storytavern-story" = "1667-story"
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryFormatError(`story ${expectedId} manifest must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  literal(candidate.format, expectedFormat, "manifest.format");
  literal(candidate.schemaVersion, 15, "manifest.schemaVersion");
  const pointer = candidate.factConsistencyRunId;
  if (typeof pointer !== "string" || !HASH_PATTERN.test(pointer)) {
    throw new StoryFormatError("manifest.factConsistencyRunId must be a SHA-256 hex digest");
  }
  const { factConsistencyRunId: _pointer, ...withoutPointer } = candidate;
  assertStrictV13Manifest(
    { ...withoutPointer, schemaVersion: 13 },
    expectedId,
    expectedFormat
  );
}
