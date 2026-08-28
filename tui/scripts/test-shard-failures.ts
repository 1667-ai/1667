export interface FailedTest {
  readonly file: string;
  readonly name: string;
}

export function parseFailures(stderr: string): readonly FailedTest[] | null {
  const failures: FailedTest[] = [];
  let file: string | null = null;
  let reportedCount: number | null = null;
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (/^# Unhandled error\b/u.test(trimmed)
      || /^\d+ errors?$/u.test(trimmed)) return null;
    const summary = trimmed.match(/^(\d+) tests? failed:$/u);
    if (summary !== null) {
      reportedCount = Number.parseInt(summary[1]!, 10);
      file = null;
      continue;
    }
    if (reportedCount !== null) continue;
    const headingText = trimmed.startsWith("::group::")
      ? trimmed.slice("::group::".length)
      : trimmed;
    const heading = headingText.match(/^(.+\.(?:[cm]?[jt]sx?)):$/u);
    if (heading !== null) {
      file = heading[1]!;
      continue;
    }
    if (trimmed.endsWith(":")) file = null;
    if (file === null) continue;
    const match = trimmed.match(/^\(fail\) (.*?)(?: \[[\d.]+(?:ms|s)\])?$/u);
    if (match === null) continue;
    failures.push({ file, name: match[1]! });
  }
  return reportedCount === failures.length ? failures : null;
}
