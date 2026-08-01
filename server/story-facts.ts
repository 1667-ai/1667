import { randomUUID } from "node:crypto";
import { ServiceError as HttpError } from "./errors.js";
import {
  FactActivationError,
  parseFactActivation,
  parseFactKeys,
  parseFactMetadata,
  selectActiveFacts,
  selectActiveFactsForRewrite,
  type FactScanContext
} from "../shared/fact-activation.js";
import { formatFactsMessage } from "../shared/story-facts.js";
import { activePath, isChapterSummary } from "../shared/story-tree.js";
import { hasUnpairedSurrogate } from "./story-format.js";
import { hasDefinedProperty, requireRecord } from "./validation.js";
import {
  MAX_FACTS,
  MAX_FACT_TEXT_CHARS,
  MAX_FACT_TAG_CHARS,
  type Story,
  type StoryFact
} from "../shared/types.js";
import { unicodeScalarLength } from "../shared/unicode.js";

type Body = Record<string, unknown>;

export function createFacts(
  story: Story,
  value: unknown,
  idForIndex: (index: number) => string = () => randomUUID()
): boolean {
  const inputs = factInputs(requireRecord(value, "fact input"));
  // Validate the complete batch before touching the story. A bad later entry must
  // never leave an earlier imported fact behind.
  const parsed = inputs.map((input) => ({
    tag: parseTag(input.tag),
    text: parseText(input.text),
    sourcePartId: parseSourcePartId(story, input.sourcePartId),
    ...parseMetadata(input.activation, input.keys)
  }));
  const ids = parsed.map((_, index) => idForIndex(index));
  const existingIds = new Set(story.facts.map((fact) => fact.id));
  if (ids.some((id) => existingIds.has(id))) {
    if (ids.every((id) => existingIds.has(id))) return false;
    throw new HttpError(409, "Only part of this fact mutation was found; reload the story.");
  }
  const remaining = MAX_FACTS - story.facts.length;
  if (inputs.length > remaining) {
    if (inputs.length === 1 && remaining === 0) {
      throw new HttpError(409, `This story already has the maximum of ${MAX_FACTS} facts; delete a fact first.`);
    }
    throw new HttpError(409, `This story has room for ${remaining} more facts; the import contains ${inputs.length}.`);
  }
  const now = new Date().toISOString();
  story.facts.push(...parsed.map(({ tag, text, sourcePartId, activation, keys }, index) => ({
    id: ids[index]!, tag, text, activation, keys, createdAt: now, updatedAt: now,
    ...(sourcePartId === undefined ? {} : { sourcePartId })
  })));
  return true;
}

function factInputs(body: Body): Body[] {
  const hasBatch = hasDefinedProperty(body, "facts");
  const hasSingle = hasDefinedProperty(body, "tag") || hasDefinedProperty(body, "text")
    || hasDefinedProperty(body, "sourcePartId") || hasDefinedProperty(body, "activation")
    || hasDefinedProperty(body, "keys");
  if (!hasBatch) return [body];
  if (hasSingle) throw new HttpError(400, "Provide one fact or a facts batch, not both.");
  if (!Array.isArray(body.facts)) throw new HttpError(400, "Facts batch must be an array.");
  if (body.facts.length === 0) throw new HttpError(400, "Facts batch cannot be empty.");
  if (body.facts.length > MAX_FACTS) {
    throw new HttpError(400, `Facts batch exceeds the maximum of ${MAX_FACTS} facts.`);
  }
  return body.facts.map((input, index) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(400, `Invalid fact at batch index ${index}.`);
    }
    return input as Body;
  });
}

export function patchFact(story: Story, factId: string, value: unknown): void {
  const body = requireRecord(value, "fact patch");
  const fact = findFact(story, factId);
  const hasTag = hasDefinedProperty(body, "tag");
  const hasText = hasDefinedProperty(body, "text");
  const hasActivation = hasDefinedProperty(body, "activation");
  const hasKeys = hasDefinedProperty(body, "keys");
  if (!hasTag && !hasText && !hasActivation && !hasKeys) {
    throw new HttpError(400, "Provide fact fields to update the fact.");
  }
  if (hasTag) fact.tag = parseTag(body.tag);
  if (hasText) fact.text = parseText(body.text);
  if (hasActivation) fact.activation = parseActivation(body.activation);
  if (hasKeys) fact.keys = parseKeys(body.keys);
  fact.updatedAt = new Date().toISOString();
}

export function deleteFact(story: Story, factId: string): void {
  const index = story.facts.findIndex((fact) => fact.id === factId);
  if (index === -1) throw new HttpError(404, `Fact not found: ${factId}`);
  story.facts.splice(index, 1);
}

export function factsSystemMessage(story: Story, context?: FactScanContext): string | null {
  return formatFactsMessage(selectActiveFacts(story.facts, context));
}

export function rewriteFactsSystemMessage(
  story: Story,
  partId: string,
  instruction: string,
  selectedText: string
): string | null {
  return formatFactsMessage(selectActiveFactsForRewrite(
    story.facts,
    activePath(story),
    partId,
    story.chapterBreaks,
    story.nodes,
    instruction,
    selectedText
  ));
}

function findFact(story: Story, factId: string): StoryFact {
  const fact = story.facts.find((candidate) => candidate.id === factId);
  if (fact === undefined) throw new HttpError(404, `Fact not found: ${factId}`);
  return fact;
}

function parseTag(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "Invalid tag");
  const tag = value.trim();
  assertWellFormed(tag, "Fact tag");
  if (unicodeScalarLength(tag, MAX_FACT_TAG_CHARS) > MAX_FACT_TAG_CHARS) {
    throw new HttpError(400, `Fact tag exceeds the ${MAX_FACT_TAG_CHARS}-character limit.`);
  }
  return tag.length === 0 ? null : tag;
}

function parseText(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Missing fact text");
  if (value.trim().length === 0) throw new HttpError(400, "Fact text cannot be empty.");
  assertWellFormed(value, "Fact text");
  if (value.length > MAX_FACT_TEXT_CHARS) {
    throw new HttpError(400, `Fact text exceeds the ${MAX_FACT_TEXT_CHARS}-character limit.`);
  }
  return value;
}

function parseSourcePartId(story: Story, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "sourcePartId must be a string when provided");
  if (!story.nodes.some((node) => node.id === value && !isChapterSummary(node))) {
    throw new HttpError(400, `Unknown source part: ${value}`);
  }
  return value;
}

function assertWellFormed(value: string, label: string): void {
  if (hasUnpairedSurrogate(value)) throw new HttpError(400, `${label} contains invalid Unicode.`);
}

function parseMetadata(activation: unknown, keys: unknown): { activation: StoryFact["activation"], keys: string[] } {
  try {
    return parseFactMetadata(activation, keys);
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}

function parseActivation(value: unknown): StoryFact["activation"] {
  try {
    return parseFactActivation(value);
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}

function parseKeys(value: unknown): string[] {
  try {
    return parseFactKeys(value);
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}
