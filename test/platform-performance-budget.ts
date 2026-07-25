/**
 * GitHub's Intel macOS runner is substantially slower than the arm64 and
 * Linux baselines for filesystem-heavy fixtures. Keep the same workload and
 * allow only that native architecture a documented budget scale.
 */
export const PLATFORM_PERFORMANCE_BUDGET_SCALE =
  process.platform === "darwin" && process.arch === "x64" ? 3 : 1;

export function platformPerformanceBudget(baseMilliseconds: number): number {
  return baseMilliseconds * PLATFORM_PERFORMANCE_BUDGET_SCALE;
}
