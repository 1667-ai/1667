import assert from "node:assert/strict";
import test from "node:test";
import { steppedScalarValue } from "../renderer-controls.js";

// No DOM here: `steppedScalarValue` is the pure round-then-clamp math behind
// the scalar's chevron/keyboard step (review-fixes-3 #12). Rounding after an
// earlier clamp could walk a value back out of range — the Fact cap
// (`min: 1`, `step: 100`) stepping down from 1 used to land on 0, which Save
// then rejected.

test("scalar step: stepping down from the minimum stays at the minimum after rounding", () => {
  assert.equal(steppedScalarValue(1, -100, 1, 1_000_000, 100), 1);
});

test("scalar step: an in-range step rounds to the nearest step size", () => {
  assert.equal(steppedScalarValue(240, 80, 0, 1_000_000, 100), 300);
});

test("scalar step: stepping up past the maximum clamps to the maximum", () => {
  assert.equal(steppedScalarValue(950, 100, 0, 1_000, 100), 1_000);
});
