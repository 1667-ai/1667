import { randomUUID } from "node:crypto";
import { ServiceError as HttpError } from "./errors.js";
import {
  FactActivationError,
  DEFAULT_FACT_SCAN_PARTS,
  factMetadataOverrides,
  parseFactActivation,
  parseFactPriority,
  parseFactRecursion,
  parseFactScanDepth,
  parseFactSecondaryMode,
  type FactPriority
} from "../shared/fact-metadata.js";
import { parseFactKeys } from "../shared/fact-keys.js";
import { parseFactMetadata } from "../shared/fact-validation.js";
import { FactBudgetError, parseFactBudgetTokens } from "../shared/fact-budget.js";
import { isChapterSummary } from "../shared/story-tree.js";
import { hasUnpairedSurrogate } from "./story-format.js";
import { hasDefinedProperty, requireRecord } from "./validation.js";
import {
  MAX_FACTS,
  MAX_FACT_TEXT_CHARS,
  MAX_FACT_TAG_CHARS,
  type Story,
  type StoryFact
} from "../shared/types.js";
import { factTagWithinLimit, factTextWithinLimit } from "../shared/fact-limits.js";

type Body = Record<string, unknown>;

export function createFacts(
  story: Story,
  value: unknown,
  idForIndex: (index: number) => string = () => randomUUID()
): boolean {
  const inputs = factInputs(requireRecord(value, "fact input"));
  // An empty batch asks for nothing the story does not already hold, the same
  // as any other no-op request, so it reports unchanged rather than failing.
  if (inputs.length === 0) return false;
  // Validate the complete batch before touching the story. A bad later entry must
  // never leave an earlier imported fact behind.
  const parsed = inputs.map((input) => ({
    tag: parseTag(input.tag),
    text: parseText(input.text),
    sourcePartId: parseSourcePartId(story, input.sourcePartId),
    budgetTokens: parseCreateBudgetTokens(input.budgetTokens),
    ...parseMetadata({
      activation: input.activation,
      keys: input.keys,
      priority: input.priority,
      secondaryKeys: input.secondaryKeys,
      secondaryMode: input.secondaryMode,
      scanDepth: input.scanDepth,
      recursion: input.recursion
    })
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
  story.facts.push(...parsed.map((input, index) => ({
    id: ids[index]!,
    tag: input.tag,
    text: input.text,
    activation: input.activation,
    keys: input.keys,
    createdAt: now,
    updatedAt: now,
    ...factMetadataOverrides(input),
    ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens }),
    ...(input.sourcePartId === undefined ? {} : { sourcePartId: input.sourcePartId })
  })));
  return true;
}

function factInputs(body: Body): Body[] {
  const hasBatch = hasDefinedProperty(body, "facts");
  const hasSingle = [
    "tag",
    "text",
    "sourcePartId",
    "activation",
    "keys",
    "secondaryKeys",
    "secondaryMode",
    "scanDepth",
    "recursion",
    "priority",
    "budgetTokens"
  ].some((key) => hasDefinedProperty(body, key));
  if (!hasBatch) return [body];
  if (hasSingle) throw new HttpError(400, "Provide one fact or a facts batch, not both.");
  if (!Array.isArray(body.facts)) throw new HttpError(400, "Facts batch must be an array.");
  if (body.facts.length === 0) return [];
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
  const hasSecondaryKeys = hasDefinedProperty(body, "secondaryKeys");
  const hasSecondaryMode = hasDefinedProperty(body, "secondaryMode");
  const hasScanDepth = hasDefinedProperty(body, "scanDepth");
  const hasRecursion = hasDefinedProperty(body, "recursion");
  const hasPriority = hasDefinedProperty(body, "priority");
  const hasBudgetTokens = hasDefinedProperty(body, "budgetTokens");
  const hasPatch = hasTag || hasText || hasActivation || hasKeys
    || hasSecondaryKeys || hasSecondaryMode || hasScanDepth || hasRecursion
    || hasPriority || hasBudgetTokens;
  if (!hasPatch) {
    throw new HttpError(400, "Provide fact fields to update the fact.");
  }
  if (hasTag) fact.tag = parseTag(body.tag);
  if (hasText) fact.text = parseText(body.text);
  if (hasActivation) fact.activation = parseActivation(body.activation);
  if (hasKeys) fact.keys = parseKeys(body.keys);
  if (hasSecondaryKeys) {
    if (body.secondaryKeys === null) delete fact.secondaryKeys;
    else {
      const secondaryKeys = parseKeys(body.secondaryKeys);
      if (secondaryKeys.length === 0) delete fact.secondaryKeys;
      else fact.secondaryKeys = secondaryKeys;
    }
  }
  if (hasSecondaryMode) {
    if (body.secondaryMode === null) delete fact.secondaryMode;
    else {
      const mode = parseSecondaryMode(body.secondaryMode);
      if (mode === "and") delete fact.secondaryMode;
      else fact.secondaryMode = mode;
    }
  }
  if (hasScanDepth) {
    if (body.scanDepth === null) delete fact.scanDepth;
    else {
      const depth = parseScanDepth(body.scanDepth);
      if (depth === DEFAULT_FACT_SCAN_PARTS) delete fact.scanDepth;
      else fact.scanDepth = depth;
    }
  }
  if (hasRecursion) {
    if (body.recursion === null) delete fact.recursion;
    else {
      const recursion = parseRecursion(body.recursion);
      if (recursion === "on") delete fact.recursion;
      else fact.recursion = recursion;
    }
  }
  if (hasPriority) {
    const priority = parsePriority(body.priority);
    if (priority === "normal") delete fact.priority;
    else fact.priority = priority;
  }
  if (hasBudgetTokens) {
    if (body.budgetTokens === null) delete fact.budgetTokens;
    else fact.budgetTokens = parseCreateBudgetTokens(body.budgetTokens);
  }
  normalizeFactMetadata(fact);
  fact.updatedAt = new Date().toISOString();
}

export function deleteFact(story: Story, factId: string): void {
  const index = story.facts.findIndex((fact) => fact.id === factId);
  if (index === -1) throw new HttpError(404, `Fact not found: ${factId}`);
  story.facts.splice(index, 1);
}

/** Move one Fact to a new position among `story.facts` — array order is emit
 * order (see shared/story-facts.ts), so this is the "arrange Facts" control.
 * `toIndex` clamps into range rather than rejecting an out-of-date bound, so a
 * concurrent delete cannot turn a reasonable "move to the end" into an error. */
export function reorderFact(story: Story, factId: string, value: unknown): void {
  const toIndex = requireToIndex(value);
  const from = story.facts.findIndex((fact) => fact.id === factId);
  if (from === -1) throw new HttpError(404, `Fact not found: ${factId}`);
  // Where toIndex actually lands once clamped into range. Worker replay does
  // not call this separately — it clones the story and replays this whole
  // function (see server/worker-mutations.ts's reorderFact), so there is
  // nothing else here for a second copy of the clamp to agree or disagree with.
  const clamped = Math.max(0, Math.min(toIndex, story.facts.length - 1));
  if (clamped === from) return;
  const [fact] = story.facts.splice(from, 1);
  story.facts.splice(clamped, 0, fact!);
}

function requireToIndex(value: unknown): number {
  const body = requireRecord(value, "fact reorder");
  const toIndex = body.toIndex;
  if (!Number.isSafeInteger(toIndex)) throw new HttpError(400, "toIndex must be an integer");
  return toIndex as number;
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
  if (!factTagWithinLimit(tag)) {
    throw new HttpError(400, `Fact tag exceeds the ${MAX_FACT_TAG_CHARS}-character limit.`);
  }
  return tag.length === 0 ? null : tag;
}

function parseText(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Missing fact text");
  if (value.trim().length === 0) throw new HttpError(400, "Fact text cannot be empty.");
  assertWellFormed(value, "Fact text");
  if (!factTextWithinLimit(value)) {
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

function parseMetadata(
  values: Parameters<typeof parseFactMetadata>[0]
): {
  activation: StoryFact["activation"];
  keys: string[];
  priority: FactPriority;
  secondaryKeys: string[];
  secondaryMode: NonNullable<StoryFact["secondaryMode"]>;
  scanDepth: number;
  recursion: NonNullable<StoryFact["recursion"]>;
} {
  try {
    return parseFactMetadata(values, "Fact");
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}

function normalizeFactMetadata(fact: StoryFact): void {
  const metadata = factMetadataOverrides({
    secondaryKeys: fact.secondaryKeys ?? [],
    secondaryMode: fact.secondaryMode ?? "and",
    scanDepth: fact.scanDepth ?? DEFAULT_FACT_SCAN_PARTS,
    recursion: fact.recursion ?? "on",
    priority: fact.priority ?? "normal"
  });
  delete fact.secondaryKeys;
  delete fact.secondaryMode;
  delete fact.scanDepth;
  delete fact.recursion;
  delete fact.priority;
  Object.assign(fact, metadata);
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

function parsePriority(value: unknown): FactPriority {
  try {
    return parseFactPriority(value);
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}
function parseSecondaryMode(value: unknown): NonNullable<StoryFact["secondaryMode"]> {
  try {
    return parseFactSecondaryMode(value);
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}

function parseScanDepth(value: unknown): number {
  try {
    return parseFactScanDepth(value);
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}

function parseRecursion(value: unknown): NonNullable<StoryFact["recursion"]> {
  try {
    return parseFactRecursion(value);
  } catch (error) {
    if (error instanceof FactActivationError) throw new HttpError(400, error.message);
    throw error;
  }
}

/** Shared by create (undefined = uncapped) and patch (undefined never reaches
 *  here; null clears the cap, handled by the caller before this runs). */
function parseCreateBudgetTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  try {
    return parseFactBudgetTokens(value);
  } catch (error) {
    if (error instanceof FactBudgetError) throw new HttpError(400, error.message);
    throw error;
  }
}
