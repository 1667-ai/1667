import { describe, expect, test } from "bun:test";
import { createFrameProfile, distribution } from "../src/frame-profile.js";

describe("frame profiling", () => {
  test("reports nearest-rank distributions", () => {
    expect(distribution([4, 1, 3, 2, 100])).toEqual({
      samples: 5,
      p50Ms: 3,
      p95Ms: 100,
      maxMs: 100
    });
    expect(distribution([])).toEqual({ samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  });

  test("bounds retained phase samples", () => {
    const profile = createFrameProfile();
    for (let value = 0; value < 3_000; value += 1) profile.record("render", value);
    const report = profile.report({
      invalidations: 0,
      invalidationsByReason: { state: 0, resize: 0, animation: 0, "cold-ready": 0 },
      frames: 0,
      coalesced: 0,
      maxPendingAgeMs: 0,
      buildSamplesMs: []
    }, {
      slices: 0,
      completed: 0,
      replaced: 0,
      maxSliceMs: 0,
      sliceSamplesMs: []
    }, { hits: 0, misses: 0 }, null);
    expect(report.application.render.samples).toBe(2_048);
    expect(report.application.render.maxMs).toBe(2_999);
  });
});
