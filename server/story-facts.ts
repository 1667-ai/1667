import { randomUUID } from "node:crypto";
import { ServiceError as HttpError } from "./errors.js";
import { formatFactsMessage } from "../shared/story-facts.js";
import { isChapterSummary } from "../shared/story-tree.js";
import { hasUnpairedSurrogate } from "./story-format.js";
import { hasDefinedProperty, requireRecord } from "./validation.js";
import {
  MAX_FACTS,
  MAX_FACT_TEXT_CHARS,
  MAX_FACT_TAG_CHARS,
  type GenerationSettings,
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
    sourcePartId: parseSourcePartId(story, input.sourcePartId)
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
  story.facts.push(...parsed.map(({ tag, text, sourcePartId }, index) => ({
    id: ids[index]!, tag, text, createdAt: now, updatedAt: now,
    ...(sourcePartId === undefined ? {} : { sourcePartId })
  })));
  return true;
}

function factInputs(body: Body): Body[] {
  const hasBatch = hasDefinedProperty(body, "facts");
  const hasSingle = hasDefinedProperty(body, "tag") || hasDefinedProperty(body, "text")
    || hasDefinedProperty(body, "sourcePartId");
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
  if (!hasTag && !hasText) throw new HttpError(400, "Provide tag and/or text to update the fact.");
  if (hasTag) fact.tag = parseTag(body.tag);
  if (hasText) fact.text = parseText(body.text);
  fact.updatedAt = new Date().toISOString();
}

export function deleteFact(story: Story, factId: string): void {
  const index = story.facts.findIndex((fact) => fact.id === factId);
  if (index === -1) throw new HttpError(404, `Fact not found: ${factId}`);
  story.facts.splice(index, 1);
}

export function factsSystemMessage(story: Story): string | null {
  return formatFactsMessage(story.facts);
}

/** Conservative token bound for the overflow screen. Prose ASCII stays at the
 *  shared ~4-chars/token average; non-ASCII counts two tokens per code point,
 *  covering CJK (~1) and most emoji (~2-3). This is deliberately a screen, not
 *  a tokenizer — a scope decision, not an oversight: exact provider tokenizers
 *  are outside the current scope, so dense ASCII/JSON facts or multi-token
 *  emoji can slip past. The autoname budget shares the same char-level
 *  approximations. The invariant this
 *  screen serves is "never silently lose or truncate a fact": a prompt that
 *  slips past is rejected by the provider with a visible error and nothing is
 *  saved. Do not "fix" this with byte-level bounds — they refuse legitimate
 *  English facts several times too early. */
function upperBoundTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide * 2;
}

/** Facts are fixed context: when they cannot fit a known window even with all
 *  prose removed, refuse up front instead of letting the provider truncate.
 *  `otherFixed` must list the non-prose texts of the request as actually sent. */
export function assertFactsFit(
  settings: GenerationSettings,
  facts: string | null,
  otherFixed: readonly string[]
): void {
  if (facts === null || settings.contextWindow === null) return;
  const fixedTexts = [facts, ...otherFixed];
  const framing = (fixedTexts.length + 2) * 4;
  const fixed = fixedTexts.reduce((sum, text) => sum + upperBoundTokens(text), framing);
  const usable = settings.contextWindow - settings.maxTokens;
  if (fixed <= usable) return;
  throw new HttpError(
    400,
    `The story facts are too large for the model's context window ` +
    `(~${fixed.toLocaleString()} fixed prompt tokens, ~${Math.max(0, usable).toLocaleString()} usable). ` +
    `Shorten or consolidate facts, or raise the context window in Settings.`
  );
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
