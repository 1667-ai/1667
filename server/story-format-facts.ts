import {
  MAX_FACTS,
  MAX_FACT_TAG_CHARS,
  MAX_HUMAN_EDIT_RANGES,
  MAX_REWRITTEN_SPANS,
  type HumanEditAttribution,
  type TextRange
} from "../shared/types.js";
import {
  FactActivationError,
  parseFactMetadata,
  type FactActivation,
  type FactPriority,
  type FactRecursion,
  type FactSecondaryMode
} from "../shared/fact-activation.js";
import { FactBudgetError, parseFactBudgetTokens } from "../shared/fact-budget.js";
import type { ObjectHash, StoredFactV1 } from "./story-format.js";
import { unicodeScalarLength } from "../shared/unicode.js";
import { exactStringPattern } from "./story-wire-patterns.js";

export const HASH_PATTERN = exactStringPattern("[a-f0-9]{64}");

export class StoryFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoryFormatError";
  }
}

export function requireHash(value: unknown, label: string): ObjectHash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new StoryFormatError(`Invalid ${label}`);
  return value;
}

export function parseStoredFacts(value: unknown, partIds: readonly string[]): StoredFactV1[] {
  const values = value === undefined ? [] : arrayValue(value, "facts");
  if (values.length > MAX_FACTS) throw new StoryFormatError(`facts exceeds the ${MAX_FACTS}-fact limit`);
  const factIds = new Set<string>();
  const stateIds = new Set<string>();
  const partPositions = new Map<string, number>();
  for (const [index, partId] of partIds.entries()) {
    // Temporal anchors identify parts by ID alone; a duplicate would make the
    // one-shot migration collapse pick an arbitrary state. Fail closed.
    if (partPositions.has(partId)) throw new StoryFormatError(`Duplicate story part id: ${partId}`);
    partPositions.set(partId, index + 1);
  }
  return values.map((value, factIndex) => {
    const fact = recordValue(value, `facts[${factIndex}]`);
    const id = stringField(fact, "id");
    if (factIds.has(id)) throw new StoryFormatError(`Duplicate fact id: ${id}`);
    factIds.add(id);
    const tag = fact.tag;
    if (tag !== null && typeof tag !== "string") {
      throw new StoryFormatError(`facts[${factIndex}].tag must be a string or null`);
    }
    if (tag !== null && unicodeScalarLength(tag, MAX_FACT_TAG_CHARS) > MAX_FACT_TAG_CHARS) {
      throw new StoryFormatError(`facts[${factIndex}].tag exceeds the ${MAX_FACT_TAG_CHARS}-character limit`);
    }
    const createdAt = timestampField(fact, "createdAt", `facts[${factIndex}]`);
    const metadata = parseStoredFactMetadata(fact, factIndex);
    const budgetTokens = optionalFactBudgetTokens(fact.budgetTokens, `facts[${factIndex}].budgetTokens`);
    const sourcePartId = optionalString(fact.sourcePartId, `facts[${factIndex}].sourcePartId`);
    if (sourcePartId !== undefined && !partPositions.has(sourcePartId)) {
      throw new StoryFormatError(`facts[${factIndex}].sourcePartId references an unknown part`);
    }
    // Migration replaces the fact-level updatedAt, but a malformed one still
    // marks a corrupt manifest; validate before discarding.
    timestampField(fact, "updatedAt", `facts[${factIndex}]`);
    if (fact.revisionId !== undefined) {
      return {
        id,
        tag,
        ...metadata,
        ...(budgetTokens === undefined ? {} : { budgetTokens }),
        revisionId: requireHash(fact.revisionId, `facts[${factIndex}].revisionId`),
        createdAt,
        updatedAt: timestampField(fact, "updatedAt", `facts[${factIndex}]`),
        ...(sourcePartId === undefined ? {} : { sourcePartId })
      };
    }

    // Temporal manifests collapse to the state effective latest in manifest part order.
    const stateValues = arrayField(fact, "states");
    if (stateValues.length === 0) throw new StoryFormatError(`facts[${factIndex}].states must not be empty`);
    const boundaries = new Set<string | null>();
    let latest: { revisionId: ObjectHash; updatedAt: string; position: number } | undefined;
    for (const [stateIndex, value] of stateValues.entries()) {
      const state = recordValue(value, `facts[${factIndex}].states[${stateIndex}]`);
      const stateId = stringField(state, "id");
      if (stateIds.has(stateId)) throw new StoryFormatError(`Duplicate fact state id: ${stateId}`);
      stateIds.add(stateId);
      const anchor = state.effectiveAfterPartId;
      if (anchor !== null && typeof anchor !== "string") {
        throw new StoryFormatError(
          `facts[${factIndex}].states[${stateIndex}].effectiveAfterPartId must be a string or null`
        );
      }
      const position = anchor === null ? 0 : partPositions.get(anchor);
      if (position === undefined) {
        throw new StoryFormatError(`Fact state anchor references unknown part: ${anchor}`);
      }
      if (boundaries.has(anchor)) throw new StoryFormatError(`Fact ${id} has duplicate state boundaries`);
      boundaries.add(anchor);
      const candidate = {
        revisionId: requireHash(state.revisionId, `facts[${factIndex}].states[${stateIndex}].revisionId`),
        updatedAt: timestampField(state, "updatedAt", `facts[${factIndex}].states[${stateIndex}]`),
        position
      };
      timestampField(state, "createdAt", `facts[${factIndex}].states[${stateIndex}]`);
      if (latest === undefined || candidate.position > latest.position) latest = candidate;
    }
    if (latest === undefined) throw new StoryFormatError(`facts[${factIndex}].states must not be empty`);
    return {
      id,
      tag,
      ...metadata,
      ...(budgetTokens === undefined ? {} : { budgetTokens }),
      revisionId: latest.revisionId,
      createdAt,
      updatedAt: latest.updatedAt,
      ...(sourcePartId === undefined ? {} : { sourcePartId })
    };
  });
}

function parseStoredFactMetadata(
  fact: Record<string, unknown>,
  factIndex: number
): {
  activation?: FactActivation;
  keys?: string[];
  priority?: FactPriority;
  secondaryKeys?: string[];
  secondaryMode?: FactSecondaryMode;
  scanDepth?: number;
  recursion?: FactRecursion;
} {
  try {
    const metadata = parseFactMetadata(
      fact.activation,
      fact.keys,
      `facts[${factIndex}]`,
      fact.priority,
      fact.secondaryKeys,
      fact.secondaryMode,
      fact.scanDepth,
      fact.recursion
    );
    return {
      ...(fact.activation === undefined ? {} : { activation: metadata.activation }),
      ...(fact.keys === undefined ? {} : { keys: metadata.keys }),
      ...(fact.priority === undefined ? {} : { priority: metadata.priority }),
      ...(fact.secondaryKeys === undefined ? {} : { secondaryKeys: metadata.secondaryKeys }),
      ...(fact.secondaryMode === undefined ? {} : { secondaryMode: metadata.secondaryMode }),
      ...(fact.scanDepth === undefined ? {} : { scanDepth: metadata.scanDepth }),
      ...(fact.recursion === undefined ? {} : { recursion: metadata.recursion })
    };
  } catch (error) {
    if (error instanceof FactActivationError) throw new StoryFormatError(error.message);
    throw error;
  }
}

export function parseVersionAttributions(
  value: unknown,
  label: string,
  expectedLength: number
): Array<HumanEditAttribution | null> | undefined {
  if (value === undefined) return undefined;
  const entries = arrayValue(value, label);
  if (entries.length !== expectedLength) {
    throw new StoryFormatError(`${label} must align with the part's versions`);
  }
  return entries.map((entry, attributionIndex) => {
    if (entry === null) return null;
    const attribution = recordValue(entry, `${label}[${attributionIndex}]`);
    if (attribution.source !== "human") {
      throw new StoryFormatError(`${label}[${attributionIndex}].source must be human`);
    }
    const ranges = arrayField(attribution, "ranges");
    if (ranges.length > MAX_HUMAN_EDIT_RANGES) {
      throw new StoryFormatError(`${label}[${attributionIndex}].ranges exceeds the attribution range limit`);
    }
    const parsedRanges = ranges.map((range, rangeIndex) => {
      const parsed = recordValue(range, `${label}[${attributionIndex}].ranges[${rangeIndex}]`);
      return {
        start: integerField(parsed, "start"),
        end: integerField(parsed, "end")
      };
    });
    let previousEnd = -1;
    for (const range of parsedRanges) {
      if (range.start < 0 || range.start >= range.end || range.start < previousEnd) {
        throw new StoryFormatError(`${label}[${attributionIndex}] has an invalid human edit range`);
      }
      previousEnd = range.end;
    }
    const deletedCharacters = optionalDeletedCharacters(
      attribution.deletedCharacters,
      `${label}[${attributionIndex}].deletedCharacters`
    );
    return {
      source: "human",
      ranges: parsedRanges,
      ...(deletedCharacters === undefined ? {} : { deletedCharacters })
    };
  });
}

export function parseSingleAttribution(
  value: unknown,
  label: string
): HumanEditAttribution | null | undefined {
  if (value === undefined) return undefined;
  return parseVersionAttributions([value], label, 1)?.[0];
}

/** Same sorted, non-overlapping, bounded shape `parseVersionAttributions`
 *  enforces for attribution ranges, without the "human" wrapper: a rewritten
 *  span is a plain TextRange list. */
export function parseRewrittenSpans(value: unknown, label: string): TextRange[] | undefined {
  if (value === undefined) return undefined;
  const entries = arrayValue(value, label);
  if (entries.length > MAX_REWRITTEN_SPANS) {
    throw new StoryFormatError(`${label} exceeds the ${MAX_REWRITTEN_SPANS}-span limit`);
  }
  const ranges = entries.map((entry, index) => {
    const range = recordValue(entry, `${label}[${index}]`);
    return { start: integerField(range, "start"), end: integerField(range, "end") };
  });
  let previousEnd = -1;
  for (const range of ranges) {
    if (range.start < 0 || range.start >= range.end || range.start < previousEnd) {
      throw new StoryFormatError(`${label} has an invalid rewritten span`);
    }
    previousEnd = range.end;
  }
  return ranges;
}

/** Restore payloads predate manifest attribution normalization. Keep their
 * accepted wire semantics while sharing the format layer's primitive parsers. */
export function parseRestoredAttribution(
  value: unknown,
  label: string
): HumanEditAttribution | null | undefined {
  if (value === undefined || value === null) return value;
  const attribution = recordValue(value, label);
  if (attribution.source !== "human") throw new StoryFormatError(`${label}.source must be human`);
  const ranges = arrayField(attribution, "ranges").map((value, index) => {
    const range = recordValue(value, `${label}.ranges[${index}]`);
    return { start: integerField(range, "start"), end: integerField(range, "end") };
  });
  const deletedCharacters = attribution.deletedCharacters === undefined
    ? undefined
    : integerValue(attribution.deletedCharacters, `${label}.deletedCharacters`);
  return {
    source: "human",
    ranges,
    ...(deletedCharacters === undefined ? {} : { deletedCharacters })
  };
}

export function validateVersionAttributions(
  partId: string,
  attributions: Array<HumanEditAttribution | null> | undefined,
  texts: readonly string[]
): void {
  if (attributions === undefined) return;
  if (attributions.length !== texts.length) {
    throw new StoryFormatError(`Part ${partId} versionAttributions must align with its versions`);
  }
  for (const [attributionIndex, attribution] of attributions.entries()) {
    if (attribution === null) continue;
    if (attribution.source !== "human" || attribution.ranges.length > MAX_HUMAN_EDIT_RANGES) {
      throw new StoryFormatError(`Part ${partId} has invalid human edit attribution`);
    }
    if (
      attribution.deletedCharacters !== undefined
      && (!Number.isSafeInteger(attribution.deletedCharacters) || attribution.deletedCharacters < 1)
    ) {
      throw new StoryFormatError(`Part ${partId} has invalid deleted character attribution`);
    }
    let previousEnd = -1;
    for (const range of attribution.ranges) {
      if (
        !Number.isSafeInteger(range.start)
        || !Number.isSafeInteger(range.end)
        || range.start < 0
        || range.start >= range.end
        || range.end > texts[attributionIndex]!.length
        || range.start < previousEnd
      ) {
        throw new StoryFormatError(`Part ${partId} has an invalid human edit range`);
      }
      previousEnd = range.end;
    }
  }
}

export function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryFormatError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  return arrayValue(value[field], field);
}

export function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new StoryFormatError(`${label} must be an array`);
  return value;
}

export function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") throw new StoryFormatError(`${field} must be a string`);
  return result;
}

export function timestampField(value: Record<string, unknown>, field: string, label: string): string {
  const result = stringField(value, field);
  if (Number.isNaN(Date.parse(result))) throw new StoryFormatError(`${label}.${field} must be a valid timestamp`);
  return result;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new StoryFormatError(`${label} must be a string`);
  return value;
}

export function integerField(value: Record<string, unknown>, field: string): number {
  return integerValue(value[field], field);
}

export function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new StoryFormatError(`${label} must be an integer`);
  return value as number;
}

export function optionalFactBudgetTokens(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  try {
    return parseFactBudgetTokens(value, label);
  } catch (error) {
    if (error instanceof FactBudgetError) throw new StoryFormatError(error.message);
    throw error;
  }
}

function optionalDeletedCharacters(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const result = integerValue(value, label);
  if (result < 1) throw new StoryFormatError(`${label} must be a positive integer`);
  return result;
}
