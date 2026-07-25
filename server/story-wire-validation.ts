import { StoryFormatError } from "./story-format-facts.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "../shared/unicode.js";

export interface ClosedObjectShape {
  readonly required: readonly string[];
  readonly allowed: ReadonlySet<string>;
}

export function closedShape(
  required: readonly string[],
  optional: readonly string[] = []
): ClosedObjectShape {
  return { required, allowed: new Set([...required, ...optional]) };
}

export function closedRecord(
  value: unknown,
  label: string,
  shape: ClosedObjectShape
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryFormatError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!shape.allowed.has(key)) throw new StoryFormatError(`${label} contains unknown key: ${key}`);
  }
  for (const key of shape.required) {
    if (!Object.hasOwn(record, key)) throw new StoryFormatError(`${label} is missing required key: ${key}`);
  }
  return record;
}

export function boundedArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) throw new StoryFormatError(`${label} must be an array`);
  if (value.length > maxItems) {
    throw new StoryFormatError(`${label} exceeds the ${maxItems.toLocaleString()}-item limit`);
  }
  return value;
}

export function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { minLength?: number } = {}
): string {
  if (typeof value !== "string") throw new StoryFormatError(`${label} must be a string`);
  if (hasUnpairedSurrogate(value)) throw new StoryFormatError(`${label} contains an unpaired Unicode surrogate`);
  const length = unicodeScalarLength(value, maxLength);
  if (length < (options.minLength ?? 0) || length > maxLength) {
    const minimum = options.minLength === undefined ? "" : `${options.minLength.toLocaleString()}–`;
    throw new StoryFormatError(
      `${label} must contain ${minimum}${maxLength.toLocaleString()} Unicode scalar values`
    );
  }
  return value;
}

export function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { minLength?: number } = {}
): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maxLength, options);
}

export function nullableBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { minLength?: number } = {}
): string | null {
  return value === null ? null : boundedString(value, label, maxLength, options);
}

export function safeInteger(
  value: unknown,
  label: string,
  options: { min?: number; max?: number } = {}
): number {
  if (!Number.isSafeInteger(value)) throw new StoryFormatError(`${label} must be an integer`);
  const parsed = value as number;
  if (options.min !== undefined && parsed < options.min) {
    throw new StoryFormatError(`${label} must be at least ${options.min}`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new StoryFormatError(`${label} must be at most ${options.max}`);
  }
  return parsed;
}

export function dateString(value: unknown, label: string, maxLength: number): string {
  const parsed = boundedString(value, label, maxLength);
  if (Number.isNaN(Date.parse(parsed))) throw new StoryFormatError(`${label} must be a valid timestamp`);
  return parsed;
}

export function literal<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  label: string
): T {
  if (value !== expected) throw new StoryFormatError(`${label} must be ${JSON.stringify(expected)}`);
  return expected;
}
