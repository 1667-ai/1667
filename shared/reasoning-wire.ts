import { hasUnpairedSurrogate } from "./unicode.js";
import type { ReasoningRecord, CapturedReasoning } from "./reasoning.js";

const REASONING_FORMAT = "1667-reasoning";
const REASONING_SCHEMA_VERSION = 1;
const MAX_REASONING_BYTES = 4 * 1024 * 1024;

export class ReasoningFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReasoningFormatError";
  }
}

export function createReasoningRecord(captured: CapturedReasoning): ReasoningRecord {
  const { text, tokenCount } = captured;
  if (hasUnpairedSurrogate(text)) {
    throw new ReasoningFormatError("text contains an unpaired Unicode surrogate");
  }
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
    throw new ReasoningFormatError("tokenCount must be a non-negative integer");
  }
  const record: ReasoningRecord = {
    format: REASONING_FORMAT,
    schemaVersion: REASONING_SCHEMA_VERSION,
    text,
    tokenCount
  };
  assertEncodedSize(record);
  return record;
}

/** Byte-stable: the same record always produces the same bytes. */
export function serializeReasoning(record: ReasoningRecord): string {
  return JSON.stringify({
    format: record.format,
    schemaVersion: record.schemaVersion,
    text: record.text,
    tokenCount: record.tokenCount
  });
}

/** Parse the canonical wire shape without the optional content hash check. */
export function parseReasoningWire(raw: string): ReasoningRecord {
  if (new TextEncoder().encode(raw).byteLength > MAX_REASONING_BYTES) {
    throw new ReasoningFormatError(
      `Reasoning exceeds the ${MAX_REASONING_BYTES.toLocaleString()}-byte size limit`
    );
  }
  const value = parseJsonObject(raw);
  if (value.format !== REASONING_FORMAT) {
    throw new ReasoningFormatError("Unsupported reasoning format");
  }
  if (value.schemaVersion !== REASONING_SCHEMA_VERSION) {
    throw new ReasoningFormatError("Unsupported reasoning schema version");
  }
  requireKeys(value, ["format", "schemaVersion", "text", "tokenCount"], "reasoning");
  const text = requireString(value.text, "text");
  const tokenCount = requireSafeInteger(value.tokenCount, "tokenCount");
  const record = createReasoningRecord({ text, tokenCount });
  if (serializeReasoning(record) !== raw) {
    throw new ReasoningFormatError("Reasoning is not canonically serialized");
  }
  return record;
}

function assertEncodedSize(record: ReasoningRecord): void {
  const bytes = new TextEncoder().encode(serializeReasoning(record)).byteLength;
  if (bytes > MAX_REASONING_BYTES) {
    throw new ReasoningFormatError(
      `Reasoning exceeds the ${MAX_REASONING_BYTES.toLocaleString()}-byte size limit`
    );
  }
}

function requireKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ReasoningFormatError(`${label} contains unknown key: ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new ReasoningFormatError(`${label} is missing required key: ${key}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ReasoningFormatError(`${label} must be a string`);
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ReasoningFormatError(`${label} must be an integer`);
  return value as number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReasoningFormatError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(raw) as unknown, "reasoning");
  } catch (error) {
    if (error instanceof ReasoningFormatError) throw error;
    throw new ReasoningFormatError("Invalid JSON in reasoning", { cause: error });
  }
}
