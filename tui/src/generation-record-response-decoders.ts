import {
  GenerationRecordFormatError,
  type GenerationRecordSummary,
  type ResolvedGenerationRecord
} from "../../shared/generation-record.js";
import {
  parseGenerationRecordSummary,
  parseResolvedGenerationRecord
} from "../../shared/generation-record-resolved.js";

/**
 * Decodes the two Generation Record routes' JSON bodies. All shape and bound
 * validation — the canonical enums, the size limits, the `unsupportedReason`
 * pairing rule, every field a malformed response could get wrong — lives in
 * `shared/generation-record-resolved.ts`, the same module `server/stories.ts`
 * would validate against if it ever needed to. This file's only job is
 * transport wording: turning a `GenerationRecordFormatError` (a field path
 * and a reason) into the `Error` the rest of the TUI expects from a decoder.
 */

export function decodeGenerationRecordSummariesResponse(value: unknown): GenerationRecordSummary[] {
  if (!Array.isArray(value)) throw new Error("The server returned an invalid Generation Record list.");
  return value.map((entry, index) =>
    decodeOrWrap(() => parseGenerationRecordSummary(entry, `Generation Record summary[${index}]`)));
}

export function decodeGenerationRecordResponse(value: unknown): ResolvedGenerationRecord {
  return decodeOrWrap(() => parseResolvedGenerationRecord(value, "Generation Record"));
}

function decodeOrWrap<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof GenerationRecordFormatError) {
      throw new Error(`The server returned an invalid response: ${error.message}`);
    }
    throw error;
  }
}
