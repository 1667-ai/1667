import { describe, expect, test } from "bun:test";
import type { ResolvedGenerationRecord } from "../../shared/generation-record.js";
import { createGenerationRecordDetailCache } from "../src/generation-record-detail-cache.js";

/**
 * The viewer itself only ever steps one event at a time (see
 * generation-record-viewer-integration.test.ts, "the detail cache stays
 * bounded while paging"), which cannot isolate get()'s promote-on-read
 * effect from the plain insertion order every step also disturbs. This
 * exercises the cache module directly — the explicit boundary this defect
 * asked for, not a private implementation detail — to pin down that finer
 * eviction rule.
 */

function detail(kind: ResolvedGenerationRecord["kind"]): ResolvedGenerationRecord {
  return {
    format: "1667-generation-record",
    schemaVersion: 1,
    kind,
    createdAt: "2026-01-01T00:00:00.000Z",
    provider: { provider: "dry-run", model: "dry-run" },
    effective: { wireProtocol: "dry-run", fields: [], adjustments: [] },
    prompt: {
      operation: "continue",
      entries: [{ role: "user", stability: "volatile", kind: "request", source: "text", text: "Continue." }]
    }
  };
}

describe("generation record detail cache", () => {
  test("holds up to its bound, then evicts the least recently used entry", () => {
    const cache = createGenerationRecordDetailCache(2);
    const a = detail("continue");
    const b = detail("append");
    const c = detail("rewrite-take");

    cache.set("a", a);
    cache.set("b", b);
    expect(cache.get("a")).toBe(a);
    expect(cache.get("b")).toBe(b);

    // Over the bound: "a" was inserted first and is the least recently
    // used, so it falls out to make room for "c".
    cache.set("c", c);
    expect(cache.get("a")).toBe(undefined);
    expect(cache.get("b")).toBe(b);
    expect(cache.get("c")).toBe(c);
  });

  test("a read counts as a use, protecting a stale entry from eviction ahead of a fresher, untouched one", () => {
    const cache = createGenerationRecordDetailCache(2);
    const a = detail("continue");
    const b = detail("append");
    const c = detail("rewrite-take");

    cache.set("a", a);
    cache.set("b", b);
    // Touch "a" again — it is now the more recently used of the two,
    // despite "b" having been inserted later.
    expect(cache.get("a")).toBe(a);

    // Over the bound: "b" is now the least recently used, not "a".
    cache.set("c", c);
    expect(cache.get("b")).toBe(undefined);
    expect(cache.get("a")).toBe(a);
    expect(cache.get("c")).toBe(c);
  });

  test("re-setting an existing key refreshes its recency without growing past the bound", () => {
    const cache = createGenerationRecordDetailCache(2);
    const a = detail("continue");
    const b = detail("append");
    const updatedA = detail("rewrite-take");

    cache.set("a", a);
    cache.set("b", b);
    cache.set("a", updatedA);
    expect(cache.get("a")).toBe(updatedA);
    expect(cache.get("b")).toBe(b);
  });
});
