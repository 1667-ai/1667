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
import {
  canonicalFactStates,
  factStatesTextWithinLimit,
  isLegacyFactStateShape,
  type FactState,
  type FactTextState
} from "../shared/fact-state.js";
import { normalizeFactName } from "../shared/fact-name.js";
import { hasUnpairedSurrogate } from "./story-format.js";
import { hasDefinedProperty, requireRecord } from "./validation.js";
import {
  MAX_FACTS,
  MAX_FACT_STATES,
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
    name: parseName(input.name),
    tag: parseTag(input.tag),
    text: parseText(input.text),
    anchorPartId: parseAnchorPartId(story, input.anchorPartId),
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
    ...(input.name === undefined ? {} : { name: input.name }),
    tag: input.tag,
    states: [{
      id: ids[index]!,
      ...(input.anchorPartId === undefined ? {} : { anchorPartId: input.anchorPartId }),
      text: input.text,
      createdAt: now,
      updatedAt: now
    }],
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
    "name",
    "text",
    "sourcePartId",
    "anchorPartId",
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

export function patchFact(story: Story, factId: string, value: unknown): boolean {
  const body = requireRecord(value, "fact patch");
  const fact = findFact(story, factId);
  const candidate = cloneFact(fact);
  const hasTag = hasDefinedProperty(body, "tag");
  const hasName = hasDefinedProperty(body, "name");
  const hasText = hasDefinedProperty(body, "text");
  const hasActivation = hasDefinedProperty(body, "activation");
  const hasKeys = hasDefinedProperty(body, "keys");
  const hasSecondaryKeys = hasDefinedProperty(body, "secondaryKeys");
  const hasSecondaryMode = hasDefinedProperty(body, "secondaryMode");
  const hasScanDepth = hasDefinedProperty(body, "scanDepth");
  const hasRecursion = hasDefinedProperty(body, "recursion");
  const hasPriority = hasDefinedProperty(body, "priority");
  const hasBudgetTokens = hasDefinedProperty(body, "budgetTokens");
  let textStateChanged = false;
  const hasPatch = hasName || hasTag || hasText || hasActivation || hasKeys
    || hasSecondaryKeys || hasSecondaryMode || hasScanDepth || hasRecursion
    || hasPriority || hasBudgetTokens;
  if (!hasPatch) {
    throw new HttpError(400, "Provide fact fields to update the fact.");
  }
  if (hasName) {
    const name = parseName(body.name);
    if (name === undefined) delete candidate.name;
    else candidate.name = name;
  }
  if (hasTag) candidate.tag = parseTag(body.tag);
  if (hasText) {
    const states = canonicalFactStates(candidate);
    if (states.length > 1) {
      throw new HttpError(400, "A Fact with several states must edit a state by id.");
    }
    const text = parseText(body.text);
    const state = states[0];
    if (state === undefined || !("text" in state)) {
      throw new HttpError(400, "A Fact must have one text state to edit its text.");
    }
    textStateChanged = state.text !== text;
    candidate.states = [{ ...state, text }];
  }
  if (hasActivation) candidate.activation = parseActivation(body.activation);
  if (hasKeys) candidate.keys = parseKeys(body.keys);
  if (hasSecondaryKeys) {
    if (body.secondaryKeys === null) delete candidate.secondaryKeys;
    else {
      const secondaryKeys = parseKeys(body.secondaryKeys);
      if (secondaryKeys.length === 0) delete candidate.secondaryKeys;
      else candidate.secondaryKeys = secondaryKeys;
    }
  }
  if (hasSecondaryMode) {
    if (body.secondaryMode === null) delete candidate.secondaryMode;
    else {
      const mode = parseSecondaryMode(body.secondaryMode);
      if (mode === "and") delete candidate.secondaryMode;
      else candidate.secondaryMode = mode;
    }
  }
  if (hasScanDepth) {
    if (body.scanDepth === null) delete candidate.scanDepth;
    else {
      const depth = parseScanDepth(body.scanDepth);
      if (depth === DEFAULT_FACT_SCAN_PARTS) delete candidate.scanDepth;
      else candidate.scanDepth = depth;
    }
  }
  if (hasRecursion) {
    if (body.recursion === null) delete candidate.recursion;
    else {
      const recursion = parseRecursion(body.recursion);
      if (recursion === "on") delete candidate.recursion;
      else candidate.recursion = recursion;
    }
  }
  if (hasPriority) {
    const priority = parsePriority(body.priority);
    if (priority === "normal") delete candidate.priority;
    else candidate.priority = priority;
  }
  if (hasBudgetTokens) {
    if (body.budgetTokens === null) delete candidate.budgetTokens;
    else candidate.budgetTokens = parseCreateBudgetTokens(body.budgetTokens);
  }
  normalizeFactMetadata(candidate);
  validateAggregateText(candidate);
  if (sameFactIgnoringClocks(fact, candidate)) return false;
  const now = new Date().toISOString();
  // A text edit changes the canonical state's own revision clock even when
  // other metadata already forced the Fact into the successor shape.
  if (textStateChanged) {
    candidate.states = candidate.states.map((state) => ({ ...state, updatedAt: now }));
  }
  if (isLegacyLowerableFact(candidate)) {
    const state = canonicalFactStates(candidate)[0]!;
    candidate.states = [{ ...state, updatedAt: now }];
  }
  candidate.updatedAt = now;
  replaceFact(fact, candidate);
  return true;
}

/** Add one state to a Fact. The caller supplies the deterministic state id
 * when the mutation is replayed by the worker; direct calls use a UUID. */
export function createFactState(
  story: Story,
  factId: string,
  value: unknown,
  stateId: string = randomUUID()
): boolean {
  const body = requireRecord(value, "fact state");
  const sourceFact = findFact(story, factId);
  const staged = stageStateMetadata(story, factId, body);
  const parsed = parseStateValue(body, staged.story, "fact state");
  const anchorPartId = parseAnchorPartId(staged.story, body.anchorPartId);
  const states = [...canonicalFactStates(staged.fact)];
  const existing = states.find((state) => state.id === stateId);
  if (existing !== undefined) {
    if (sameStateInput(existing, parsed, anchorPartId)) {
      if (staged.metadataChanged) replaceFact(sourceFact, staged.fact);
      return staged.metadataChanged;
    }
    throw new HttpError(409, `Fact state id already exists: ${stateId}`);
  }
  if (staged.story.facts.some((candidate) => canonicalFactStates(candidate).some((state) => state.id === stateId))) {
    throw new HttpError(409, `Fact state id already exists: ${stateId}`);
  }
  if (states.length >= MAX_FACT_STATES) {
    throw new HttpError(409, `This Fact already has the maximum of ${MAX_FACT_STATES} states.`);
  }
  if (states.some((state) => state.anchorPartId === anchorPartId)) {
    throw new HttpError(409, "A Fact cannot have two states at the same Anchor.");
  }
  const now = new Date().toISOString();
  const state: FactState = {
    id: stateId,
    ...(anchorPartId === undefined ? {} : { anchorPartId }),
    ...parsed,
    createdAt: now,
    updatedAt: now
  } as FactState;
  const candidate = staged.fact;
  candidate.states = [...states, state];
  validateAggregateText(candidate);
  candidate.updatedAt = now;
  replaceFact(sourceFact, candidate);
  return true;
}

/** Edit one state. A patch with only `anchorPartId` is valid and keeps the
 * state text or End State unchanged. */
export function patchFactState(
  story: Story,
  factId: string,
  stateId: string,
  value: unknown
): boolean {
  const body = requireRecord(value, "fact state patch");
  const sourceFact = findFact(story, factId);
  const sourceStates = [...canonicalFactStates(sourceFact)];
  const index = sourceStates.findIndex((state) => state.id === stateId);
  if (index < 0) throw new HttpError(404, `Fact state not found: ${stateId}`);
  const hasAnchor = hasDefinedProperty(body, "anchorPartId");
  const hasText = hasDefinedProperty(body, "text");
  const hasEnds = hasDefinedProperty(body, "ends");
  if (!hasAnchor && !hasText && !hasEnds) {
    throw new HttpError(400, "Provide text, ends, or anchorPartId to update the fact state.");
  }
  // Apply metadata only after the state mutation shape is valid. A metadata-
  // only body belongs to patchFact, and must never be accepted here.
  const staged = stageStateMetadata(story, factId, body);
  const states = [...canonicalFactStates(staged.fact)];
  if (hasText && hasEnds) {
    throw new HttpError(400, "A fact state must contain text or ends, not both.");
  }
  const current = states[index]!;
  const anchorPartId = hasAnchor
    ? parseAnchorPartId(staged.story, body.anchorPartId)
    : current.anchorPartId;
  if (states.some((state, candidateIndex) => candidateIndex !== index && state.anchorPartId === anchorPartId)) {
    throw new HttpError(409, "A Fact cannot have two states at the same Anchor.");
  }
  const valuePatch = hasText || hasEnds ? parseStateValue(body, staged.story, "fact state patch") : null;
  const nextValue = {
    id: current.id,
    ...(anchorPartId === undefined ? {} : { anchorPartId }),
    ...(valuePatch ?? ("ends" in current ? { ends: true } : { text: current.text })),
  };
  if (sameStateInput(current, nextValue, anchorPartId)) {
    if (staged.metadataChanged) replaceFact(sourceFact, staged.fact);
    return staged.metadataChanged;
  }
  const now = new Date().toISOString();
  const next: FactState = { ...nextValue, createdAt: current.createdAt, updatedAt: now } as FactState;
  states[index] = next;
  staged.fact.states = states;
  validateAggregateText(staged.fact);
  staged.fact.updatedAt = next.updatedAt;
  replaceFact(sourceFact, staged.fact);
  return true;
}

function stageStateMetadata(
  story: Story,
  factId: string,
  body: Record<string, unknown>
): { readonly story: Story; readonly fact: StoryFact; readonly metadataChanged: boolean } {
  const sourceFact = findFact(story, factId);
  const candidateFact = cloneFact(sourceFact);
  const candidateStory: Story = {
    ...story,
    facts: story.facts.map((fact) => fact === sourceFact ? candidateFact : fact)
  };
  const metadataChanged = applyStateMetadata(candidateStory, factId, body);
  return {
    story: candidateStory,
    fact: findFact(candidateStory, factId),
    metadataChanged
  };
}

function applyStateMetadata(story: Story, factId: string, body: Record<string, unknown>): boolean {
  if (!hasDefinedProperty(body, "metadata")) return false;
  const metadata = requireRecord(body.metadata, "fact state metadata");
  if (hasDefinedProperty(metadata, "text")) {
    throw new HttpError(400, "Fact state metadata cannot edit state text.");
  }
  return patchFact(story, factId, metadata);
}

/** Remove one state. Removing the final state removes its Fact. */
export function deleteFactState(story: Story, factId: string, stateId: string): boolean {
  const factIndex = story.facts.findIndex((candidate) => candidate.id === factId);
  if (factIndex < 0) throw new HttpError(404, `Fact not found: ${factId}`);
  const fact = story.facts[factIndex]!;
  const states = [...canonicalFactStates(fact)];
  const stateIndex = states.findIndex((state) => state.id === stateId);
  if (stateIndex < 0) throw new HttpError(404, `Fact state not found: ${stateId}`);
  if (states.length === 1) story.facts.splice(factIndex, 1);
  else {
    const candidate = cloneFact(fact);
    states.splice(stateIndex, 1);
    candidate.states = states;
    candidate.updatedAt = new Date().toISOString();
    replaceFact(fact, candidate);
  }
  return true;
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

function parseName(value: unknown): string | undefined {
  try {
    return normalizeFactName(value);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid Fact name");
  }
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
  if (!story.nodes.some((node) => node.id === value)) {
    throw new HttpError(400, `Unknown source part: ${value}`);
  }
  return value;
}

function parseAnchorPartId(story: Story, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "anchorPartId must be a string or null");
  if (!story.nodes.some((node) => node.id === value && node.role !== "summary")) {
    throw new HttpError(400, `Unknown anchor part: ${value}`);
  }
  return value;
}

type ParsedStateValue = { readonly text: string } | { readonly ends: true };

function parseStateValue(body: Body, _story: Story, label: string): ParsedStateValue {
  const hasText = hasDefinedProperty(body, "text");
  const hasEnds = hasDefinedProperty(body, "ends");
  if (hasText === hasEnds) {
    throw new HttpError(400, `${label} must contain exactly one of text or ends: true.`);
  }
  if (hasEnds) {
    if (body.ends !== true) throw new HttpError(400, `${label}.ends must be true.`);
    return { ends: true };
  }
  return { text: parseText(body.text) };
}

function sameStateInput(
  current: FactState,
  value: ParsedStateValue | { readonly text?: string; readonly ends?: true },
  anchorPartId: string | undefined
): boolean {
  if (current.anchorPartId !== anchorPartId) return false;
  if ("ends" in value) return "ends" in current && current.ends === true;
  return "text" in current && current.text === value.text;
}

function cloneFact(fact: StoryFact): StoryFact {
  return {
    ...fact,
    keys: [...fact.keys],
    states: canonicalFactStates(fact).map((state) => ({ ...state }))
  };
}

/** Apply a normalized candidate without leaving cleared optional metadata on
 * the live Fact. `Object.assign` alone keeps an old `name`, `priority`, or
 * other defaulted field when a patch deletes it. */
function replaceFact(target: StoryFact, candidate: StoryFact): void {
  for (const field of [
    "name",
    "secondaryKeys",
    "secondaryMode",
    "scanDepth",
    "recursion",
    "priority",
    "budgetTokens",
    "sourcePartId"
  ] as const) {
    if (!(field in candidate)) delete target[field];
  }
  Object.assign(target, candidate);
}

function isLegacyLowerableFact(fact: StoryFact): boolean {
  if (fact.name !== undefined) return false;
  // A Fact that left the legacy shape must keep its independent state clock.
  // Re-clearing metadata must not silently collapse that history back into
  // the legacy encoding.
  return isLegacyFactStateShape(fact);
}

function sameFactIgnoringClocks(left: StoryFact, right: StoryFact): boolean {
  return JSON.stringify(stripFactClocks(left)) === JSON.stringify(stripFactClocks(right));
}

function stripFactClocks(fact: StoryFact): unknown {
  const states = canonicalFactStates(fact).map((state) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = state;
    return value;
  });
  const { createdAt: _createdAt, updatedAt: _updatedAt, states: _states, ...metadata } = fact;
  return { ...metadata, states };
}

function validateAggregateText(fact: StoryFact): void {
  const states = canonicalFactStates(fact);
  if (!factStatesTextWithinLimit(states)) {
    throw new HttpError(400, `Fact states exceed the ${MAX_FACT_TEXT_CHARS}-character aggregate limit.`);
  }
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
