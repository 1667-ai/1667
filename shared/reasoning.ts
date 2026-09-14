import { createHash } from "node:crypto";
import {
  createReasoningRecord,
  parseReasoningWire,
  serializeReasoning,
  ReasoningFormatError
} from "./reasoning-wire.js";
export { ReasoningFormatError } from "./reasoning-wire.js";

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

export { createReasoningRecord, serializeReasoning };

export interface ReasoningRecord {
  readonly format: typeof REASONING_FORMAT;
  readonly schemaVersion: typeof REASONING_SCHEMA_VERSION;
  readonly text: string;
  readonly tokenCount: number;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

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
  return parseReasoningWire(raw);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
