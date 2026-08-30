import {
  MAX_FACTS,
  MAX_FACT_TAG_CHARS,
  MAX_GENERATION_RECORD_IDS,
  MAX_HUMAN_EDIT_RANGES,
  MAX_RECENT_LINES,
  MAX_REWRITTEN_SPANS,
  MAX_STORED_TITLE_CHARS
} from "../shared/types.js";
import { MAX_AUTHORS_NOTE_CHARS, MAX_AUTHORS_NOTE_DEPTH } from "../shared/authors-note.js";
import { MAX_AUTHOR_BRIEF_CHARS } from "../shared/author-brief.js";
import { HASH_PATTERN, StoryFormatError } from "./story-format-facts.js";
import { exactStringPattern } from "./story-wire-patterns.js";
import {
  boundedArray,
  boundedString,
  closedRecord,
  closedShape,
  dateString,
  literal,
  nullableBoundedString,
  optionalBoundedString,
  safeInteger
} from "./story-wire-validation.js";
import { FactActivationError } from "../shared/fact-metadata.js";
import { parseFactMetadata } from "../shared/fact-validation.js";
import { MAX_FACT_BUDGET_TOKENS, MAX_STORY_FACTS_BUDGET_TOKENS } from "../shared/fact-budget.js";
import {
  SAMPLING_BANNED_STRINGS_POLICY,
  SAMPLING_PHRASE_BIAS_POLICY
} from "../shared/sampling-validation-policy.js";

export const MAX_STORY_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_STORY_TITLE_CHARS = MAX_STORED_TITLE_CHARS;
export const MAX_STORY_COLLECTION_ITEMS = 65_536;
export const MAX_STORY_IDENTIFIER_CHARS = 1_024;
export const MAX_STORY_INSTRUCTION_CHARS = 1024 * 1024;
export const MAX_STORY_MODEL_CHARS = 1_024;
export const MAX_STORY_COLOR_CHARS = 128;
export const MAX_STORY_TIMESTAMP_CHARS = 64;

export const STORY_ID_PATTERN_SOURCE = "(?:[A-Za-z0-9-]{1,255}|st1_[a-z2-7]{51}[aq])";
export const STORY_ID_PATTERN = exactStringPattern(STORY_ID_PATTERN_SOURCE);

export const ROOT = closedShape([
  "format", "schemaVersion", "id", "title", "createdAt", "updatedAt", "activeWordCount",
  "nodes", "facts", "activeRootId", "bookmarks", "recentNodeIds", "chapterBreaks"
], [
  "origin", "authorsNote", "authorsNoteDepth", "authorBrief", "phraseBias", "bannedStrings",
  "autonameId", "firstChapterTitle", "factsBudgetTokens"
]);
const ORIGIN = closedShape(["storyId", "storyTitle", "partId", "offset", "createdAt"]);
export const NODE = closedShape([
  "id", "parentId", "instruction", "model", "createdAt", "revisionId", "activeChildId"
], [
  "preview", "words", "tokens", "updatedAt", "genId", "rewriteId", "role", "chapterBreakId",
  "coveredExtent", "madeAt", "editedByUser", "human", "syntheticEmpty", "tokenProbabilityId",
  "generationRecordIds", "reasoningId", "attribution", "rewrittenSpans"
]);
const EXTENT = closedShape(["fromPartId", "toPartId"]);
const ATTRIBUTION = closedShape(["source", "ranges"], ["deletedCharacters"]);
const RANGE = closedShape(["start", "end"]);
const FACT = closedShape(
  ["id", "tag", "revisionId", "createdAt", "updatedAt"],
  ["sourcePartId", "activation", "keys", "secondaryKeys", "secondaryMode", "scanDepth", "recursion", "priority", "budgetTokens"]
);
const TAG = closedShape(["nodeId", "name", "label", "color", "createdAt"]);
const CHAPTER_BREAK = closedShape(["id", "parentPartId", "title", "createdAt"]);
const PHRASE_BIAS_ENTRY = closedShape(["phrase", "weight"]);

export function isStoryId(value: string): boolean {
  return STORY_ID_PATTERN.test(value);
}

export function requireStoryId(value: unknown, label: string): string {
  const id = boundedString(value, label, 255, { minLength: 1 });
  if (!isStoryId(id)) throw new StoryFormatError(`${label} is not a canonical story id`);
  return id;
}

/** Structural closure and resource bounds for the already-shipped V5 wire shape.
 * Existing parsers remain responsible for graph and chapter consistency. */
export function assertStrictV5Manifest(
  value: unknown,
  expectedId: string,
  expectedFormat: "1667-story" | "storytavern-story" = "1667-story"
): asserts value is Record<string, unknown> {
  const manifest = closedRecord(value, `story ${expectedId} manifest`, ROOT);
  literal(manifest.format, expectedFormat, "manifest.format");
  literal(manifest.schemaVersion, 5, "manifest.schemaVersion");
  assertManifestCommonFields(manifest, expectedId, assertNode);
}

/** Every manifest-root field that means the same thing regardless of which
 * node shape the content payload carries. The successor content payload
 * (`server/story-v7-strict.ts`) reuses this rather than repeating it, passing
 * its own node asserter so the one place the two shapes actually differ,
 * `nodes[]`, stays the caller's choice. */
export function assertManifestCommonFields(
  manifest: Record<string, unknown>,
  expectedId: string,
  assertManifestNode: (value: unknown, label: string) => void,
  assertManifestFact: (value: unknown, label: string) => void = assertFact
): void {
  const id = requireStoryId(manifest.id, "manifest.id");
  if (id !== expectedId) throw new StoryFormatError(`Story id mismatch: expected ${expectedId}, found ${id}`);
  boundedString(manifest.title, "manifest.title", MAX_STORY_TITLE_CHARS);
  timestamp(manifest.createdAt, "manifest.createdAt");
  timestamp(manifest.updatedAt, "manifest.updatedAt");
  safeInteger(manifest.activeWordCount, "manifest.activeWordCount", { min: 0 });
  if (manifest.origin !== undefined) assertOrigin(manifest.origin);
  optionalIdentifier(manifest.autonameId, "manifest.autonameId");
  if (manifest.firstChapterTitle !== undefined) {
    boundedString(manifest.firstChapterTitle, "manifest.firstChapterTitle", MAX_STORY_TITLE_CHARS);
  }
  optionalBoundedString(manifest.authorsNote, "manifest.authorsNote", MAX_AUTHORS_NOTE_CHARS);
  if (manifest.authorsNoteDepth !== undefined) {
    safeInteger(manifest.authorsNoteDepth, "manifest.authorsNoteDepth", { min: 1, max: MAX_AUTHORS_NOTE_DEPTH });
  }
  optionalBoundedString(manifest.authorBrief, "manifest.authorBrief", MAX_AUTHOR_BRIEF_CHARS);
  if (manifest.phraseBias !== undefined) {
    boundedArray(manifest.phraseBias, "manifest.phraseBias", SAMPLING_PHRASE_BIAS_POLICY.maxEntries)
      .forEach((entry, index) => assertPhraseBiasEntry(entry, `manifest.phraseBias[${index}]`));
  }
  if (manifest.bannedStrings !== undefined) {
    boundedArray(manifest.bannedStrings, "manifest.bannedStrings", SAMPLING_BANNED_STRINGS_POLICY.maxEntries)
      .forEach((entry, index) =>
        boundedString(entry, `manifest.bannedStrings[${index}]`, SAMPLING_BANNED_STRINGS_POLICY.maxScalars, { minLength: 1 }));
  }
  if (manifest.factsBudgetTokens !== undefined) {
    safeInteger(manifest.factsBudgetTokens, "manifest.factsBudgetTokens", { min: 1, max: MAX_STORY_FACTS_BUDGET_TOKENS });
  }
  boundedArray(manifest.nodes, "manifest.nodes", MAX_STORY_COLLECTION_ITEMS)
    .forEach((entry, index) => assertManifestNode(entry, `manifest.nodes[${index}]`));
  boundedArray(manifest.facts, "manifest.facts", MAX_FACTS)
    .forEach((entry, index) => assertManifestFact(entry, `manifest.facts[${index}]`));
  nullableIdentifier(manifest.activeRootId, "manifest.activeRootId");
  boundedArray(manifest.bookmarks, "manifest.bookmarks", MAX_STORY_COLLECTION_ITEMS)
    .forEach((entry, index) => assertTag(entry, `manifest.bookmarks[${index}]`));
  boundedArray(manifest.recentNodeIds, "manifest.recentNodeIds", MAX_RECENT_LINES)
    .forEach((entry, index) => identifier(entry, `manifest.recentNodeIds[${index}]`));
  boundedArray(manifest.chapterBreaks, "manifest.chapterBreaks", MAX_STORY_COLLECTION_ITEMS)
    .forEach((entry, index) => assertChapterBreak(entry, `manifest.chapterBreaks[${index}]`));
}

export function assertOrigin(value: unknown): void {
  const origin = closedRecord(value, "manifest.origin", ORIGIN);
  requireStoryId(origin.storyId, "manifest.origin.storyId");
  boundedString(origin.storyTitle, "manifest.origin.storyTitle", MAX_STORY_TITLE_CHARS);
  identifier(origin.partId, "manifest.origin.partId");
  if (origin.offset !== null) safeInteger(origin.offset, "manifest.origin.offset", { min: 0 });
  timestamp(origin.createdAt, "manifest.origin.createdAt");
}

function assertNode(value: unknown, label: string): void {
  const node = closedRecord(value, label, NODE);
  assertNodeCommonFields(node, label);
}

/** Every stored-node field that means the same thing regardless of which
 * closed key set the caller already checked. The successor node shape
 * (`server/story-v7-strict.ts`) calls this after its own `closedRecord` pass
 * admits `imageAttachments`, then validates that one extra field itself. */
export function assertNodeCommonFields(node: Record<string, unknown>, label: string): void {
  identifier(node.id, `${label}.id`);
  nullableIdentifier(node.parentId, `${label}.parentId`);
  boundedString(node.instruction, `${label}.instruction`, MAX_STORY_INSTRUCTION_CHARS);
  boundedString(node.model, `${label}.model`, MAX_STORY_MODEL_CHARS);
  timestamp(node.createdAt, `${label}.createdAt`);
  optionalBoundedString(node.preview, `${label}.preview`, 100);
  optionalInteger(node.words, `${label}.words`);
  optionalInteger(node.tokens, `${label}.tokens`);
  optionalTimestamp(node.updatedAt, `${label}.updatedAt`);
  optionalIdentifier(node.genId, `${label}.genId`);
  optionalIdentifier(node.rewriteId, `${label}.rewriteId`);
  if (node.role !== undefined) literal(node.role, "summary", `${label}.role`);
  optionalIdentifier(node.chapterBreakId, `${label}.chapterBreakId`);
  if (node.coveredExtent !== undefined) assertExtent(node.coveredExtent, `${label}.coveredExtent`);
  optionalTimestamp(node.madeAt, `${label}.madeAt`);
  for (const field of ["editedByUser", "human", "syntheticEmpty"] as const) {
    if (node[field] !== undefined) literal(node[field], true, `${label}.${field}`);
  }
  assertHash(node.revisionId, `${label}.revisionId`);
  if (node.tokenProbabilityId !== undefined) {
    assertHash(node.tokenProbabilityId, `${label}.tokenProbabilityId`);
  }
  if (node.generationRecordIds !== undefined) {
    const ids = boundedArray(node.generationRecordIds, `${label}.generationRecordIds`, MAX_GENERATION_RECORD_IDS);
    if (ids.length === 0) throw new StoryFormatError(`${label}.generationRecordIds must not be empty when present`);
    ids.forEach((id, index) => assertHash(id, `${label}.generationRecordIds[${index}]`));
  }
  if (node.reasoningId !== undefined) {
    assertHash(node.reasoningId, `${label}.reasoningId`);
  }
  if (node.attribution !== undefined && node.attribution !== null) {
    assertAttribution(node.attribution, `${label}.attribution`);
  }
  if (node.rewrittenSpans !== undefined) {
    assertRewrittenSpans(node.rewrittenSpans, `${label}.rewrittenSpans`);
  }
  nullableIdentifier(node.activeChildId, `${label}.activeChildId`);
}

function assertExtent(value: unknown, label: string): void {
  const extent = closedRecord(value, label, EXTENT);
  identifier(extent.fromPartId, `${label}.fromPartId`);
  identifier(extent.toPartId, `${label}.toPartId`);
}

function assertAttribution(value: unknown, label: string): void {
  const attribution = closedRecord(value, label, ATTRIBUTION);
  literal(attribution.source, "human", `${label}.source`);
  boundedArray(attribution.ranges, `${label}.ranges`, MAX_HUMAN_EDIT_RANGES).forEach((entry, index) => {
    const rangeLabel = `${label}.ranges[${index}]`;
    const range = closedRecord(entry, rangeLabel, RANGE);
    safeInteger(range.start, `${rangeLabel}.start`, { min: 0 });
    safeInteger(range.end, `${rangeLabel}.end`, { min: 0 });
  });
  if (attribution.deletedCharacters !== undefined) {
    safeInteger(attribution.deletedCharacters, `${label}.deletedCharacters`, { min: 1 });
  }
}

function assertRewrittenSpans(value: unknown, label: string): void {
  boundedArray(value, label, MAX_REWRITTEN_SPANS).forEach((entry, index) => {
    const rangeLabel = `${label}[${index}]`;
    const range = closedRecord(entry, rangeLabel, RANGE);
    safeInteger(range.start, `${rangeLabel}.start`, { min: 0 });
    safeInteger(range.end, `${rangeLabel}.end`, { min: 0 });
  });
}

function assertFact(value: unknown, label: string): void {
  const fact = closedRecord(value, label, FACT);
  identifier(fact.id, `${label}.id`);
  if (fact.tag !== null) boundedString(fact.tag, `${label}.tag`, MAX_FACT_TAG_CHARS);
  assertHash(fact.revisionId, `${label}.revisionId`);
  timestamp(fact.createdAt, `${label}.createdAt`);
  timestamp(fact.updatedAt, `${label}.updatedAt`);
  optionalIdentifier(fact.sourcePartId, `${label}.sourcePartId`);
  try {
    parseFactMetadata(fact, label);
  } catch (error) {
    if (error instanceof FactActivationError) throw new StoryFormatError(error.message);
    throw error;
  }
  if (fact.budgetTokens !== undefined) {
    safeInteger(fact.budgetTokens, `${label}.budgetTokens`, { min: 1, max: MAX_FACT_BUDGET_TOKENS });
  }
}

function assertTag(value: unknown, label: string): void {
  const tag = closedRecord(value, label, TAG);
  identifier(tag.nodeId, `${label}.nodeId`);
  boundedString(tag.name, `${label}.name`, 80, { minLength: 1 });
  boundedString(tag.label, `${label}.label`, 16);
  boundedString(tag.color, `${label}.color`, MAX_STORY_COLOR_CHARS);
  timestamp(tag.createdAt, `${label}.createdAt`);
}

function assertChapterBreak(value: unknown, label: string): void {
  const chapterBreak = closedRecord(value, label, CHAPTER_BREAK);
  identifier(chapterBreak.id, `${label}.id`);
  identifier(chapterBreak.parentPartId, `${label}.parentPartId`);
  boundedString(chapterBreak.title, `${label}.title`, MAX_STORY_TITLE_CHARS);
  timestamp(chapterBreak.createdAt, `${label}.createdAt`);
}

function assertPhraseBiasEntry(value: unknown, label: string): void {
  const entry = closedRecord(value, label, PHRASE_BIAS_ENTRY);
  boundedString(entry.phrase, `${label}.phrase`, SAMPLING_PHRASE_BIAS_POLICY.maxPhraseScalars, { minLength: 1 });
  safeInteger(entry.weight, `${label}.weight`, {
    min: SAMPLING_PHRASE_BIAS_POLICY.minimum,
    max: SAMPLING_PHRASE_BIAS_POLICY.maximum
  });
}

export function identifier(value: unknown, label: string): string {
  return boundedString(value, label, MAX_STORY_IDENTIFIER_CHARS, { minLength: 1 });
}

export function optionalIdentifier(value: unknown, label: string): string | undefined {
  return optionalBoundedString(value, label, MAX_STORY_IDENTIFIER_CHARS, { minLength: 1 });
}

export function nullableIdentifier(value: unknown, label: string): string | null {
  return nullableBoundedString(value, label, MAX_STORY_IDENTIFIER_CHARS, { minLength: 1 });
}

export function optionalInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : safeInteger(value, label, { min: 0 });
}

export function timestamp(value: unknown, label: string): string {
  return dateString(value, label, MAX_STORY_TIMESTAMP_CHARS);
}

export function optionalTimestamp(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : timestamp(value, label);
}

export function assertHash(value: unknown, label: string): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new StoryFormatError(`Invalid ${label}`);
  }
}
