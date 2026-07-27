import { performance } from "node:perf_hooks";

// This module owns one decision: how a test measures performance work, and how
// large the budget for that work can be.
//
// A test measures one of two kinds of work.
//
// Pure computation measures CPU time. It must not measure wall-clock time. A
// hosted runner can share one core between jobs. The runner then reports a
// wall-clock time many times its own CPU time. A 20,000-cycle worker benchmark
// on darwin-arm64 measured 70ms of CPU time against 466ms of wall-clock time
// while the rest of the suite ran beside it. That delay comes from the
// scheduler, not from the product. A wall-clock budget counts the delay as
// product time and fails the test at random.
//
// File work measures wall-clock time, because a read or a write does not consume
// CPU time.
//
// CPU time cannot see a wait. A blocking read, a synchronous message, or a lock
// inside a computation shows a large wall-clock time and a small CPU time, and
// it stays inside a CPU budget. Use a CPU budget to keep an algorithm bounded.
// Use an end-to-end test to prove that a path does not block.
//
// process.cpuUsage counts every thread in the process. A test runner that keeps
// many files in one process therefore bills other work to this measurement.
// Node starts one process for each test file, so the node suite is safe.
//
// A thread also makes CPU time larger than wall-clock time. Bun collects garbage
// on other threads, so an allocation-heavy Bun benchmark reports more CPU time
// than wall-clock time. Do not copy a wall-clock limit into a Bun CPU budget.
// Measure the work first, then set the limit.
//
// Windows advances its CPU-time clock about every 16ms. Work below that step can
// report 0ms of CPU time, so keep a CPU budget well above 16ms.
//
// Use cpuBudget for computation. Use fileBudget for file work. The measure that
// a budget names is the measure that assertWithinBudget reads, so a budget and
// its measure cannot disagree.
//
// Both kinds of budget take the runner scale below, but for different reasons.
// A slower core uses more CPU time for the same computation: the arm64 baseline
// measured 744ms of CPU time for work that the Intel macOS runner measured at
// 2010.8ms. A slower filesystem uses more wall-clock time for the same file
// work. The two properties name the same targets today, so one table supplies
// both scales.

export function platformPerformanceBudgetScale(
  platform: NodeJS.Platform,
  architecture: string,
  emulatedX64: string | undefined
): number {
  // Windows filesystem fixtures run through NTFS and Defender on the hosted
  // runner. Keep the same product workload with a documented runner scale.
  if (platform === "win32" && architecture === "x64") return 2;
  // GitHub's Intel macOS runner is substantially slower than the arm64 and
  // Linux baselines, both for filesystem-heavy fixtures and for computation.
  // It measured 2010.8ms of CPU time for work that arm64 measured at 744ms.
  if (platform === "darwin" && architecture === "x64") return 3;
  // Local arm64-to-amd64 QEMU keeps the native Linux workload and receives a
  // smaller documented scale. GitHub's native Linux x64 lane never sets this.
  if (
    platform === "linux"
    && architecture === "x64"
    && emulatedX64 === "1"
  ) {
    return 2;
  }
  return 1;
}

const PLATFORM_PERFORMANCE_BUDGET_SCALE =
  platformPerformanceBudgetScale(
    process.platform,
    process.arch,
    process.env.AI_1667_TEST_EMULATED_X64
  );

/** Scales a wall-clock milliseconds value for the current runner. */
export function platformPerformanceBudget(baseMilliseconds: number): number {
  return baseMilliseconds * PLATFORM_PERFORMANCE_BUDGET_SCALE;
}

export interface Timing {
  readonly wallMs: number;
  readonly cpuMs: number;
}

/** Starts a stopwatch. Call the result to read the CPU time and the wall-clock time. */
export function startTiming(): () => Timing {
  const startedCpu = process.cpuUsage();
  const startedAt = performance.now();
  return () => {
    const wallMs = performance.now() - startedAt;
    const usage = process.cpuUsage(startedCpu);
    return { wallMs, cpuMs: (usage.user + usage.system) / 1_000 };
  };
}

/** Makes the diagnostic text for a timing. */
function timingText({ cpuMs, wallMs }: Timing): string {
  if (Number.isNaN(cpuMs)) return `${wallMs.toFixed(1)}ms wall-clock`;
  return `${cpuMs.toFixed(1)}ms CPU / ${wallMs.toFixed(1)}ms wall-clock`;
}

export interface Budget {
  readonly limitMs: number;
  readonly measure: "cpu" | "wall";
}

/** Makes a CPU-time budget for pure computation. A slower core gets the runner scale. */
export function cpuBudget(baseMilliseconds: number): Budget {
  return { limitMs: platformPerformanceBudget(baseMilliseconds), measure: "cpu" };
}

/** Makes a wall-clock budget for file work. A slower filesystem gets the runner scale. */
export function fileBudget(baseMilliseconds: number): Budget {
  return { limitMs: platformPerformanceBudget(baseMilliseconds), measure: "wall" };
}

// A test timeout is a backstop for a test that wedges. The budget assertion is
// what guards performance. So a timeout must stay above the work that the
// budgets permit, and it must stay below the CI job ceiling. A timeout above
// that ceiling makes a wedged test cancel the job, which reports no measured
// time at all.
//
// A multiple of the budget alone is not enough. Scheduler contention adds a
// delay that does not shrink with the budget: the 70ms measurement above lost
// 396ms to the scheduler, which a small budget can never cover. So the flat
// slack below covers contention, and the multiple below covers a slower run.
const TIMEOUT_HEADROOM = 2;
const CONTENTION_SLACK_MS = 30_000;
// .github/workflows/ci.yml gives each job 15 minutes.
const MAX_TEST_TIMEOUT_MS = 600_000;

/**
 * Makes a timeout that stays above the given budgets. Use it for a test timeout,
 * and for a child process that a budget measures.
 * Give setupMilliseconds for fixture work that no budget measures.
 * Always derive a test timeout from its budgets. A separate constant goes stale
 * when a budget changes. The setup value stays a constant, because no budget
 * measures fixture work.
 * The result stops at MAX_TEST_TIMEOUT_MS. No current caller reaches that limit.
 * A caller that does reach it holds a wedged test for the whole ten minutes, so
 * make the budgets tighter instead.
 */
export function budgetTimeout(budgets: Budget[], setupMilliseconds = 0): number {
  const work = budgets.reduce((total, budget) => total + budget.limitMs * TIMEOUT_HEADROOM, 0);
  return Math.min(
    work
    + platformPerformanceBudget(CONTENTION_SLACK_MS)
    + platformPerformanceBudget(setupMilliseconds),
    MAX_TEST_TIMEOUT_MS
  );
}

/**
 * Makes a timing for work that reports wall-clock time only, such as a child
 * process. Only a file budget can read it.
 */
export function wallOnlyTiming(wallMs: number): Timing {
  return { wallMs, cpuMs: Number.NaN };
}

/** Reads the measure that the budget names. */
function budgetedMs(budget: Budget, timing: Timing): number {
  if (budget.measure === "wall") return timing.wallMs;
  if (Number.isNaN(timing.cpuMs)) {
    throw new Error("A CPU budget needs a timing that measured CPU time");
  }
  return timing.cpuMs;
}

/** Reports a timing to the terminal. Use this where a test runner gives no context. */
export const CONSOLE_REPORT = {
  diagnostic: (message: string): void => console.log(message)
};

/** Reports the timing, then fails the test if the work went above its budget. */
export function assertWithinBudget(
  context: { diagnostic(message: string): void },
  label: string,
  budget: Budget,
  timing: Timing
): void {
  context.diagnostic(`${label}: ${timingText(timing)}`);
  const actualMs = budgetedMs(budget, timing);
  if (actualMs >= budget.limitMs) {
    throw new Error(
      `${label} took ${actualMs.toFixed(1)}ms ${budget.measure}; `
      + `the budget is ${budget.limitMs}ms (${timingText(timing)})`
    );
  }
}
