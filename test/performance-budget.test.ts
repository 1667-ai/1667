import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWithinBudget,
  budgetTimeout,
  cpuBudget,
  fileBudget,
  platformPerformanceBudget,
  platformPerformanceBudgetScale,
  startTiming,
  wallOnlyTiming,
  type Timing
} from "./performance-budget.js";

const SCALE = platformPerformanceBudget(1);
// A silent reporter keeps this module's own output out of the test log.
const REPORT = { diagnostic: (): void => undefined };

test("performance budgets scale only documented slow targets", () => {
  assert.equal(platformPerformanceBudgetScale("win32", "x64", undefined), 2);
  assert.equal(platformPerformanceBudgetScale("win32", "arm64", undefined), 1);
  assert.equal(platformPerformanceBudgetScale("darwin", "x64", undefined), 3);
  assert.equal(platformPerformanceBudgetScale("linux", "x64", "1"), 2);
  assert.equal(platformPerformanceBudgetScale("linux", "x64", undefined), 1);
  assert.equal(platformPerformanceBudgetScale("linux", "x64", "true"), 1);
  assert.equal(platformPerformanceBudgetScale("linux", "arm64", "1"), 1);
  assert.equal(platformPerformanceBudgetScale("darwin", "arm64", "1"), 1);
});

test("both budget kinds take the runner scale, and each names its own measure", () => {
  // A slower core uses more CPU time for the same computation. The Intel macOS
  // runner measured 2010.8ms of CPU time against a 2000ms base limit, so a CPU
  // budget must keep the runner scale.
  assert.deepEqual(cpuBudget(2_000), { limitMs: 2_000 * SCALE, measure: "cpu" });
  assert.deepEqual(fileBudget(2_000), { limitMs: 2_000 * SCALE, measure: "wall" });
  assert.ok(cpuBudget(2_000).limitMs >= 2_000, "a CPU budget never drops below its base limit");
});

test("a test timeout derived from budgets stays above them", () => {
  const cpu = cpuBudget(1_000);
  const file = fileBudget(1_000);
  // Both kinds need headroom. A timeout equal to the budget kills the test
  // before the assertion can report the measured time.
  assert.ok(budgetTimeout([cpu]) > cpu.limitMs);
  assert.ok(budgetTimeout([file]) > file.limitMs);
  // Sequential budgets accumulate, so the timeout covers all of them. The
  // contention slack is a property of the runner, so it is added once.
  assert.ok(budgetTimeout([cpu, cpu]) > budgetTimeout([cpu]));
  assert.equal(
    budgetTimeout([cpu, cpu]) - budgetTimeout([cpu]),
    budgetTimeout([cpu]) - budgetTimeout([])
  );
  // A small budget still clears the scheduler delay that a loaded runner adds.
  assert.ok(budgetTimeout([cpuBudget(1)]) > 20_000);
  // Setup work that no budget measures takes the runner scale.
  assert.equal(budgetTimeout([cpu], 500), budgetTimeout([cpu]) + 500 * SCALE);
});

test("a derived test timeout stays under the CI job ceiling", () => {
  // .github/workflows/ci.yml gives each job 15 minutes. A timeout above that
  // makes a wedged test cancel the job, which reports no measured time.
  const huge = Array.from({ length: 50 }, () => cpuBudget(60_000));
  assert.ok(budgetTimeout(huge) < 15 * 60_000);
  assert.equal(budgetTimeout(huge), budgetTimeout([...huge, cpuBudget(60_000)]));
});

test("a budget reads the measure that it names", () => {
  const slowWallFastCpu: Timing = { wallMs: 5_000, cpuMs: 10 };
  // The runner stalled this work, but the computation stayed cheap. A CPU
  // budget must pass, and a wall-clock budget must fail.
  assertWithinBudget(REPORT, "cheap computation", cpuBudget(100), slowWallFastCpu);
  assert.throws(
    () => assertWithinBudget(REPORT, "slow read", fileBudget(100), slowWallFastCpu),
    /slow read took 5000\.0ms wall/
  );
});

test("a failure reports both measures, so a reader can see the gap", () => {
  assert.throws(
    () => assertWithinBudget(REPORT, "hot loop", cpuBudget(10), { cpuMs: 70, wallMs: 466 }),
    /70\.0ms CPU \/ 466\.0ms wall-clock/
  );
});

test("a wall-only timing cannot satisfy a CPU budget by accident", () => {
  const timing = wallOnlyTiming(50);
  // A child process reports wall-clock time only. A file budget can read it.
  assertWithinBudget(REPORT, "child read", fileBudget(10_000), timing);
  // A CPU budget must refuse it rather than pass on a missing measurement.
  assert.throws(
    () => assertWithinBudget(REPORT, "child read", cpuBudget(10_000), timing),
    /needs a timing that measured CPU time/
  );
});

test("the stopwatch reports the CPU time that the work used", () => {
  // Windows advances its CPU-time clock about every 16ms, so short work can
  // report 0ms of CPU time. Compute until the wall clock passes that step.
  const read = startTiming();
  let total = 0;
  let timing = read();
  while (timing.wallMs < 100) {
    for (let index = 0; index < 1_000_000; index += 1) total += index;
    timing = read();
  }

  assert.ok(total > 0);
  assert.ok(timing.cpuMs > 0, `expected measurable CPU time, got ${timing.cpuMs}ms`);
  assert.ok(timing.wallMs > 0, `expected measurable wall-clock time, got ${timing.wallMs}ms`);
});
