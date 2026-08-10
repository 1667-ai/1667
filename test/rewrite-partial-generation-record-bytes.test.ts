import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerationRecord,
  MAX_GENERATION_RECORD_BYTES,
  type GenerationRecord,
  type GenerationRecordTextEntry
} from "../shared/generation-record.js";
import {
  PartialRewriteStash,
  maximumPartialRewriteRecordRetainedBytes,
  partialRewriteRecordRetainedBytes,
  type PartialRewriteRecord
} from "../server/rewrite-partial.js";

/**
 * Regression coverage for the Generation Record retained-byte accounting gap
 * in `server/rewrite-partial.ts`: every stashed rewrite's effect now carries
 * a `generationRecord`, but the accounting functions used to ignore it
 * entirely, so a large finalized record could blow past both the pre-stream
 * reservation and the process-wide `MAX_STASHED_PARTIAL_BYTES` cap without
 * ever being counted.
 */

/** Stands in for the small `unsupported` record `finalizeRequiredGenerationRecord`
 *  attaches before the capture collector has resolved — the real pre-stream
 *  state `reserve()` must budget for. */
function unresolvedGenerationRecord(): GenerationRecord {
  return createGenerationRecord({
    kind: "unsupported",
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: { provider: "dry-run", model: "dry-run-fixture" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: { operation: "rewrite", entries: [] },
    unsupportedReason: "No provider output was captured before this generation record was finalized."
  });
}

function baseRecord(generationRecord: GenerationRecord): PartialRewriteRecord {
  return {
    storyId: "story-1",
    nodeId: "node-1",
    attemptId: "attempt-1",
    streamedDigest: "digest-1",
    effect: {
      kind: "rewrite",
      nodeId: "node-1",
      expectedText: "The blue door opened.",
      expectedInstruction: "",
      text: "The green door opened.",
      rewriteId: "rewrite-1",
      generationRecord
    }
  };
}

/** A record close to `MAX_GENERATION_RECORD_BYTES`, well past the point a
 *  missed accounting bug would leave silently under-reserved. Comfortably
 *  under the cap so `createGenerationRecord` itself never rejects it. */
function largeGenerationRecord(): GenerationRecord {
  const entries: GenerationRecordTextEntry[] = [];
  for (let index = 0; index < 25; index++) {
    entries.push({
      role: "user",
      stability: "volatile",
      kind: "request",
      source: "text",
      text: "x".repeat(60_000)
    });
  }
  return createGenerationRecord({
    kind: "rewrite-in-place",
    createdAt: new Date().toISOString(),
    provider: { provider: "dry-run", model: "dry-run-fixture" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: { operation: "rewrite", entries }
  });
}

test("partialRewriteRecordRetainedBytes counts the finalized generation record's bytes", () => {
  const withoutRecord = partialRewriteRecordRetainedBytes(baseRecord(unresolvedGenerationRecord()));
  const record = largeGenerationRecord();
  const withRecord = partialRewriteRecordRetainedBytes(baseRecord(record));
  // The prompt text alone is 1,500,000 UTF-16 code units; a fix that still
  // ignored `generationRecord` would leave these two totals nearly equal.
  assert.ok(
    withRecord - withoutRecord > 1_000_000,
    `expected the generation record's own bytes to dominate the delta, got ${withRecord - withoutRecord}`
  );
});

test("reserve() covers a generation record that only resolves after the reservation is made", () => {
  // Mirrors the real call site (server/generation-http.ts): the pre-stream
  // effect's `generationRecord` is still the small `unsupported` stand-in
  // because the capture collector has not resolved yet, and the
  // provider-output allowance is deliberately small so the reservation would
  // starve if the generation record's worst case were not reserved for
  // separately.
  const originalRecord = baseRecord(unresolvedGenerationRecord());
  const smallProviderOutputAllowance = 8_192;
  const maximumBytes = maximumPartialRewriteRecordRetainedBytes(
    originalRecord,
    smallProviderOutputAllowance
  );
  assert.ok(
    maximumBytes >= MAX_GENERATION_RECORD_BYTES,
    "reservation must cover a generation record up to the codec's own cap"
  );

  const stash = new PartialRewriteStash();
  const reservation = stash.reserve("story-1", "node-1", "attempt-1", maximumBytes);
  const actualRecord = baseRecord(largeGenerationRecord());
  // Must not throw "Partial rewrite exceeded its pre-stream storage
  // reservation" — the whole point of reserving the worst case up front.
  stash.remember(reservation, actualRecord);
  assert.equal(stash.get("story-1", "node-1", "attempt-1"), actualRecord);
});
