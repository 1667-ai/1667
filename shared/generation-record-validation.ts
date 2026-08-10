import { createHash } from "node:crypto";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";
import { GenerationRecordFormatError } from "./generation-record-types.js";

/**
 * Generic JSON-shape and bounded-string primitives shared by every clone/
 * parse pair in `shared/generation-record.ts`. Kept apart from the codec
 * itself so that file stays focused on the record's own field-by-field
 * rules rather than these reusable, record-agnostic checks.
 */

export function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new GenerationRecordFormatError(`${label} must be a non-empty string`);
  return value;
}

export function requireBoundedString(value: string, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new GenerationRecordFormatError(`${label} must be a string`);
  if (hasUnpairedSurrogate(value)) throw new GenerationRecordFormatError(`${label} contains an unpaired Unicode surrogate`);
  if (unicodeScalarLength(value, maxChars) > maxChars) {
    throw new GenerationRecordFormatError(`${label} exceeds the ${maxChars}-character limit`);
  }
  return value;
}

/** Never truncates. A text entry over the bound fails closed so record
 *  finalization can store an explicit `kind: "unsupported"` event instead
 *  of presenting an incomplete pipeline as the full historical request. */
export function boundedEntryText(text: string, label: string, maxChars: number): string {
  if (hasUnpairedSurrogate(text)) {
    throw new GenerationRecordFormatError(`${label} contains an unpaired Unicode surrogate`);
  }
  if (unicodeScalarLength(text, maxChars) <= maxChars) {
    return text;
  }
  throw new GenerationRecordFormatError(`${label} exceeds the ${maxChars}-character limit`);
}

export function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new GenerationRecordFormatError(`${label} contains unknown key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new GenerationRecordFormatError(`${label} is missing required key: ${key}`);
  }
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GenerationRecordFormatError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GenerationRecordFormatError(`${label} must be an array`);
  return value;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new GenerationRecordFormatError(`${label} must be a string`);
  return value;
}

export function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new GenerationRecordFormatError(`${label} must be an integer`);
  return value as number;
}

export function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(raw) as unknown, label);
  } catch (error) {
    if (error instanceof GenerationRecordFormatError) throw error;
    throw new GenerationRecordFormatError(`Invalid JSON in ${label}`, { cause: error });
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
