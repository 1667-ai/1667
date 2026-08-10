import { expect, test } from "bun:test";
import { GENERATION_RECORD_FORMAT, GENERATION_RECORD_SCHEMA_VERSION } from "../../shared/generation-record.js";
import { decodeGenerationRecordResponse } from "../src/generation-record-response-decoders.js";

/**
 * A non-finite effective-field value (`Infinity`, `NaN`) can never survive a
 * real HTTP round trip — `JSON.stringify` turns both into `null` before a
 * response body ever leaves the server, so `api-compat.test.ts`'s
 * fetch-driven malformed-response cases cannot exercise this rejection. This
 * is the AGENTS.md carve-out: the decoder is called directly because no
 * end-to-end or integration path can construct the input.
 */
test("decodeGenerationRecordResponse rejects a non-finite effective-field value", () => {
  const record = {
    format: GENERATION_RECORD_FORMAT,
    schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
    kind: "continue",
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: { provider: "dry-run", model: "dry-run" },
    effective: {
      wireProtocol: "dry-run",
      fields: [{ field: "temperature", value: Number.POSITIVE_INFINITY }],
      adjustments: []
    },
    prompt: { operation: "continue", entries: [] }
  };
  expect(() => decodeGenerationRecordResponse(record)).toThrow(
    "The server returned invalid Generation Record.effective.fields[0].value."
  );
});
