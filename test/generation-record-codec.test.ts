import assert from "node:assert/strict";
import test from "node:test";
import { parseGenerationRecord } from "../shared/generation-record.js";

/**
 * Regression coverage: shared/generation-record.ts's range, provider,
 * effective-parameters, field, and adjustment parsers lost their
 * requireKeys calls when they were extracted into shared exports that
 * shared/generation-record-resolved.ts also reuses. A stored Generation
 * Record must still reject an unknown key at every one of those boundaries,
 * the same way it did before that extraction. A real HTTP round trip can
 * never construct a payload with an extra key — the server's own encoder
 * never emits one — so this calls parseGenerationRecord directly, the same
 * AGENTS.md carve-out tui/test/generation-record-response-decoders.test.ts
 * documents.
 */

function baseWireRecord(): Record<string, unknown> {
  return {
    format: "1667-generation-record",
    schemaVersion: 1,
    kind: "continue",
    createdAt: "2026-01-01T00:00:00.000Z",
    range: { start: 0, end: 10 },
    provider: { provider: "dry-run", model: "dry-run-model" },
    effective: {
      wireProtocol: "dry-run",
      fields: [{ field: "temperature", value: 0.7 }],
      adjustments: [{ stage: "construction", field: "temperature", action: "dropped" }]
    },
    prompt: {
      operation: "continue",
      entries: [{ role: "user", stability: "volatile", kind: "request", source: "text", text: "Continue." }]
    }
  };
}

test("parse rejects an unknown key on the stored range", () => {
  const wire = baseWireRecord();
  wire.range = { start: 0, end: 10, step: 1 };
  assert.throws(() => parseGenerationRecord(JSON.stringify(wire)), /range contains unknown key: step/);
});

test("parse rejects an unknown key on the stored provider", () => {
  const wire = baseWireRecord();
  wire.provider = { provider: "dry-run", model: "dry-run-model", apiKey: "sk-x" };
  assert.throws(() => parseGenerationRecord(JSON.stringify(wire)), /provider contains unknown key: apiKey/);
});

test("parse rejects an unknown key on the stored effective parameters", () => {
  const wire = baseWireRecord();
  wire.effective = { wireProtocol: "dry-run", fields: [], adjustments: [], raw: "{}" };
  assert.throws(() => parseGenerationRecord(JSON.stringify(wire)), /effective contains unknown key: raw/);
});

test("parse rejects an unknown key on an effective field", () => {
  const wire = baseWireRecord();
  wire.effective = { wireProtocol: "dry-run", fields: [{ field: "temperature", value: 0.7, extra: true }], adjustments: [] };
  assert.throws(
    () => parseGenerationRecord(JSON.stringify(wire)),
    /effective\.fields\[0\] contains unknown key: extra/
  );
});

test("parse rejects an unknown key on an effective adjustment", () => {
  const wire = baseWireRecord();
  wire.effective = {
    wireProtocol: "dry-run",
    fields: [],
    adjustments: [{ stage: "construction", field: "temperature", action: "dropped", extra: true }]
  };
  assert.throws(
    () => parseGenerationRecord(JSON.stringify(wire)),
    /effective\.adjustments\[0\] contains unknown key: extra/
  );
});
