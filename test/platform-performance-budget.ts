export function platformPerformanceBudgetScale(
  platform: NodeJS.Platform,
  architecture: string,
  emulatedX64: string | undefined
): number {
  // Windows filesystem fixtures run through NTFS and Defender on the hosted
  // runner. Keep the same product workload with a documented runner scale.
  if (platform === "win32" && architecture === "x64") return 2;
  // GitHub's Intel macOS runner is substantially slower than the arm64 and
  // Linux baselines for filesystem-heavy fixtures.
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

export const PLATFORM_PERFORMANCE_BUDGET_SCALE =
  platformPerformanceBudgetScale(
    process.platform,
    process.arch,
    process.env.AI_1667_TEST_EMULATED_X64
  );

export function platformPerformanceBudget(baseMilliseconds: number): number {
  return baseMilliseconds * PLATFORM_PERFORMANCE_BUDGET_SCALE;
}
