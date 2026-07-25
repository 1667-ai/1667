import { HASH_PATTERN } from "./story-format-facts.js";
import { requireStoryId } from "./story-v5-strict.js";
import { exactStringPattern } from "./story-wire-patterns.js";
import {
  DECIMAL_20_PATTERN,
  DECIMAL_20_PATTERN_SOURCE,
  TIME_MS_PATTERN,
  TIME_MS_PATTERN_SOURCE,
  UINT64_MAX,
  UINT64_MAX_DECIMAL,
  V6_MUTATION_ID_PATTERN,
  V6_MUTATION_ID_PATTERN_SOURCE
} from "./story-v6-scalars.js";
import type {
  Fm1Key,
  Hash256,
  LogicalAggregateKey,
  MutationId,
  Revision20,
  StoryId,
  TimeMs,
  UInt64String
} from "./mutation-ledger-types.js";

export const MAX_MUTATION_LEDGER_RECORD_BYTES = 32 * 1024;
export const MUTATION_ID_PATTERN_SOURCE = V6_MUTATION_ID_PATTERN_SOURCE;
export const FM1_KEY_PATTERN_SOURCE = "fm1:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]";

export const MUTATION_ID_PATTERN = V6_MUTATION_ID_PATTERN;
export const FM1_KEY_PATTERN = exactStringPattern(FM1_KEY_PATTERN_SOURCE);
export {
  DECIMAL_20_PATTERN,
  DECIMAL_20_PATTERN_SOURCE,
  TIME_MS_PATTERN,
  TIME_MS_PATTERN_SOURCE,
  UINT64_MAX,
  UINT64_MAX_DECIMAL
};

export class MutationLedgerFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MutationLedgerFormatError";
  }
}

export function requireMutationId(value: unknown, label = "mutationId"): MutationId {
  if (typeof value !== "string" || !MUTATION_ID_PATTERN.test(value)) {
    throw new MutationLedgerFormatError(`${label} is invalid`);
  }
  return value;
}

export function requireFm1Key(value: unknown, label = "key"): Fm1Key {
  if (typeof value !== "string" || !FM1_KEY_PATTERN.test(value)) {
    throw new MutationLedgerFormatError(`${label} is invalid`);
  }
  return value;
}

export function requireHash256(value: unknown, label: string): Hash256 {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new MutationLedgerFormatError(`${label} is invalid`);
  }
  return value;
}

export function requireTimeMs(value: unknown, label: string): TimeMs {
  if (typeof value !== "string" || !TIME_MS_PATTERN.test(value)) {
    throw new MutationLedgerFormatError(`${label} is invalid`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new MutationLedgerFormatError(`${label} is invalid`);
  }
  return value;
}

export function requireUInt53(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new MutationLedgerFormatError(`${label} must be an integer in 0..${Number.MAX_SAFE_INTEGER}`);
  }
  return value;
}

export function requireUInt32(value: unknown, label: string): number {
  const parsed = requireUInt53(value, label);
  if (parsed > 0xffff_ffff) throw new MutationLedgerFormatError(`${label} must be at most 4294967295`);
  return parsed;
}

export function requireUInt64String(
  value: unknown,
  label: string,
  options: { allowZero: boolean }
): UInt64String {
  if (typeof value !== "string" || !DECIMAL_20_PATTERN.test(value)) {
    throw new MutationLedgerFormatError(`${label} is invalid`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX || (!options.allowZero && parsed === 0n)) {
    throw new MutationLedgerFormatError(`${label} is out of range`);
  }
  return value;
}

export function requireRevision20(value: unknown, label: string): Revision20 {
  return requireUInt64String(value, label, { allowZero: false });
}

export function requireLedgerStoryId(value: unknown, label: string): StoryId {
  try {
    return requireStoryId(value, label);
  } catch (error) {
    throw new MutationLedgerFormatError(`${label} is invalid`, { cause: error });
  }
}

export function requireLogicalAggregateKey(value: unknown, label = "aggregateKey"): LogicalAggregateKey {
  if (value === "settings") return value;
  if (typeof value !== "string" || !value.startsWith("story:")) {
    throw new MutationLedgerFormatError(`${label} is invalid`);
  }
  const storyId = value.slice("story:".length);
  requireLedgerStoryId(storyId, `${label} story id`);
  return `story:${storyId}`;
}

export function storyIdFromAggregateKey(key: LogicalAggregateKey): StoryId | null {
  return key === "settings" ? null : key.slice("story:".length);
}

export function mutationTimestampMs(mutationId: MutationId): number {
  requireMutationId(mutationId);
  const value = Number(mutationId.slice(3, 16));
  if (!Number.isSafeInteger(value)) throw new MutationLedgerFormatError("mutationId timestamp is invalid");
  return value;
}

export function mutationUtcDay(mutationId: MutationId): string {
  return new Date(mutationTimestampMs(mutationId)).toISOString().slice(0, 10).replaceAll("-", "");
}
