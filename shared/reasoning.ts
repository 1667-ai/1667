import { createHash } from "node:crypto";
import { hasUnpairedSurrogate } from "./unicode.js";

/**
 * The reasoning ("thought") wire and storage format.
 *
 * A model that streams reasoning ahead of its prose hands 1667 that text one
 * increment at a time, kept on its own channel from the moment it leaves the
 * provider (`server/providers.ts`'s `ReasoningConsumer`). This module shapes
 * and bounds what gets stored once a take's generation finishes: the
 * accumulated thought and the provider's own running token count, or a count
 * of received deltas when the provider never reports one — never a
 * fabricated denominator (see `ReasoningStreamDelta` in server/providers.ts).
 *
 * 1667 stores exactly the concatenated text a take's generation produced,
 * content-addressed beside the take (`server/story-objects.ts`), mirroring
 * `shared/token-probabilities.ts` exactly. The shape is frozen now because
 * the object's bytes are hashed for that content address: a later migration
 * would have to reach every story that ever stored one.
 */
export const REASONING_FORMAT = "1667-reasoning";
export const REASONING_SCHEMA_VERSION = 1;

export const MAX_REASONING_BYTES = 4 * 1024 * 1024;

/** What the stream capture has in hand at commit time: the same fields as a
 *  stored record, kept as its own type — not a partial `ReasoningRecord` —
 *  so a capture can never be persisted without first going through
 *  `createReasoningRecord`. */
export interface CapturedReasoning {
  readonly text: string;
  readonly tokenCount: number;
}

export interface ReasoningRecord {
  readonly format: typeof REASONING_FORMAT;
  readonly schemaVersion: typeof REASONING_SCHEMA_VERSION;
  readonly text: string;
  readonly tokenCount: number;
}

export class ReasoningFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReasoningFormatError";
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** Construct a record from already-decoded parts, enforcing every bound.
 *  Both `parseReasoning` and commit-time capture
 *  (`server/story-node-reasoning.ts`) go through here, so a bound can never
 *  be enforced in one path and forgotten in the other. */
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

/** Byte-stable: the same record always produces the same bytes, because the
 *  bytes are what the object store hashes for the object's content address.
 *  One literal with a fixed key order, exactly like
 *  `serializeTokenProbabilities`. */
export function serializeReasoning(record: ReasoningRecord): string {
  return JSON.stringify({
    format: record.format,
    schemaVersion: record.schemaVersion,
    text: record.text,
    tokenCount: record.tokenCount
  });
}

/** Mirrors `parseTokenProbabilities`: check the hash first when the caller
 *  has one, decode, re-validate every bound through `createReasoningRecord`,
 *  then confirm the input was already the exact canonical bytes a fresh
 *  serialize would produce. `expectedHash` is optional here — the object
 *  store always supplies it when reading a stored object, but this layer
 *  also serves a plain round trip with no object store involved. */
export function parseReasoning(raw: string, expectedHash?: string): ReasoningRecord {
  if (Buffer.byteLength(raw, "utf8") > MAX_REASONING_BYTES) {
    throw new ReasoningFormatError(
      `Reasoning exceeds the ${MAX_REASONING_BYTES.toLocaleString()}-byte size limit`
    );
  }
  if (expectedHash !== undefined) {
    if (!HASH_PATTERN.test(expectedHash)) throw new ReasoningFormatError("Invalid reasoning id");
    if (sha256Hex(raw) !== expectedHash) {
      throw new ReasoningFormatError(`Reasoning hash mismatch: ${expectedHash}`);
    }
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
  const bytes = Buffer.byteLength(serializeReasoning(record), "utf8");
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

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
