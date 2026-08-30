import { assertStoryImageAttachments, ImageAttachmentError } from "../shared/image-attachment.js";
import { MAX_FACT_STATES, MAX_FACT_TAG_CHARS } from "../shared/types.js";
import { MAX_FACT_NAME_CHARS } from "../shared/fact-name.js";
import { MAX_FACT_BUDGET_TOKENS, MAX_STORY_FACTS_BUDGET_TOKENS } from "../shared/fact-budget.js";
import { FactActivationError } from "../shared/fact-metadata.js";
import { parseFactMetadata } from "../shared/fact-validation.js";
import { HASH_PATTERN, StoryFormatError } from "./story-format-facts.js";
import {
  assertManifestCommonFields,
  assertNodeCommonFields,
  identifier,
  NODE,
  timestamp as assertTimestamp
} from "./story-v5-strict.js";
import { assertAsideSessionRefs, assertUniqueAsideSessionIds } from "./story-v11-strict.js";
import { closedRecord, closedShape, literal, boundedArray, boundedString, safeInteger } from "./story-wire-validation.js";

const NODE13 = closedShape(
  [...NODE.required],
  [...NODE.allowed].filter((key) => !NODE.required.includes(key)).concat("imageAttachments")
);

const ROOT13 = closedShape(
  ["format", "schemaVersion", "id", "title", "createdAt", "updatedAt", "activeWordCount", "nodes", "facts",
    "activeRootId", "bookmarks", "recentNodeIds", "chapterBreaks", "asideDocumentId",
    "asideSessionRefs", "asideUnanchoredSessionRefs"],
  ["origin", "authorsNote", "authorsNoteDepth", "authorBrief", "phraseBias", "bannedStrings", "autonameId",
    "firstChapterTitle", "factsBudgetTokens"]
);

const FACT_STATE = closedShape(
  ["id", "createdAt", "updatedAt"],
  ["anchorPartId", "revisionId", "ends"]
);

const FACT13 = closedShape(
  ["id", "tag", "createdAt", "updatedAt", "states"],
  ["name", "sourcePartId", "activation", "keys", "secondaryKeys", "secondaryMode", "scanDepth", "recursion",
    "priority", "budgetTokens"]
);

/** Structural closure and resource bounds for the V13 Fact State payload.
 * Anchor existence, summary rejection, and duplicate-anchor rules run in the
 * format parser after the node graph is known. */
export function assertStrictV13Manifest(
  value: unknown,
  expectedId: string,
  expectedFormat: "1667-story" | "storytavern-story" = "1667-story"
): asserts value is Record<string, unknown> {
  const manifest = closedRecord(value, `story ${expectedId} manifest`, ROOT13);
  literal(manifest.format, expectedFormat, "manifest.format");
  literal(manifest.schemaVersion, 13, "manifest.schemaVersion");
  assertManifestCommonFields(manifest, expectedId, assertNodeV13, assertFactV13);
  if (manifest.asideDocumentId !== null
    && (typeof manifest.asideDocumentId !== "string" || !HASH_PATTERN.test(manifest.asideDocumentId))) {
    throw new StoryFormatError("manifest.asideDocumentId must be a SHA-256 hex digest or null");
  }
  const anchored = assertAsideSessionRefs(manifest.asideSessionRefs, "manifest.asideSessionRefs", false);
  const unanchored = assertAsideSessionRefs(
    manifest.asideUnanchoredSessionRefs,
    "manifest.asideUnanchoredSessionRefs",
    true
  );
  assertUniqueAsideSessionIds([...anchored, ...unanchored]);
}

function assertNodeV13(value: unknown, label: string): void {
  const node = closedRecord(value, label, NODE13);
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

function assertFactV13(value: unknown, label: string): void {
  const fact = closedRecord(value, label, FACT13);
  identifier(fact.id, `${label}.id`);
  if (fact.name !== undefined) {
    boundedString(fact.name, `${label}.name`, MAX_FACT_NAME_CHARS, { minLength: 1 });
  }
  if (fact.tag !== null) boundedString(fact.tag, `${label}.tag`, MAX_FACT_TAG_CHARS);
  assertTimestamp(fact.createdAt, `${label}.createdAt`);
  assertTimestamp(fact.updatedAt, `${label}.updatedAt`);
  if (fact.sourcePartId !== undefined) identifier(fact.sourcePartId, `${label}.sourcePartId`);
  try {
    parseFactMetadata(fact, label);
  } catch (error) {
    if (error instanceof FactActivationError) throw new StoryFormatError(error.message);
    throw error;
  }
  if (fact.budgetTokens !== undefined) {
    safeInteger(fact.budgetTokens, `${label}.budgetTokens`, { min: 1, max: MAX_FACT_BUDGET_TOKENS });
  }
  const states = boundedArray(fact.states, `${label}.states`, MAX_FACT_STATES);
  if (states.length === 0) throw new StoryFormatError(`${label}.states must not be empty`);
  states.forEach((state, index) => assertFactState(state, `${label}.states[${index}]`));
}

function assertFactState(value: unknown, label: string): void {
  const state = closedRecord(value, label, FACT_STATE);
  identifier(state.id, `${label}.id`);
  if (state.anchorPartId !== undefined) identifier(state.anchorPartId, `${label}.anchorPartId`);
  assertTimestamp(state.createdAt, `${label}.createdAt`);
  assertTimestamp(state.updatedAt, `${label}.updatedAt`);
  const hasRevision = state.revisionId !== undefined;
  const isEnd = state.ends !== undefined;
  if (hasRevision === isEnd) {
    throw new StoryFormatError(`${label} must contain exactly one of revisionId or ends`);
  }
  if (hasRevision) {
    if (typeof state.revisionId !== "string" || !HASH_PATTERN.test(state.revisionId)) {
      throw new StoryFormatError(`Invalid ${label}.revisionId`);
    }
  } else {
    literal(state.ends, true, `${label}.ends`);
  }
}
