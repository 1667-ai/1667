import assert from "node:assert/strict";
import test from "node:test";
import {
  platformPerformanceBudgetScale
} from "./platform-performance-budget.js";

test("performance budgets scale only documented slow targets", () => {
  assert.equal(platformPerformanceBudgetScale("darwin", "x64", undefined), 3);
  assert.equal(platformPerformanceBudgetScale("linux", "x64", "1"), 2);
  assert.equal(platformPerformanceBudgetScale("linux", "x64", undefined), 1);
  assert.equal(platformPerformanceBudgetScale("linux", "x64", "true"), 1);
  assert.equal(platformPerformanceBudgetScale("linux", "arm64", "1"), 1);
  assert.equal(platformPerformanceBudgetScale("darwin", "arm64", "1"), 1);
});
