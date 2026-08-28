export interface FailedTest {
  readonly file: string | null;
  readonly name: string;
}

export function parseFailures(stderr: string): readonly FailedTest[] | null {
  const detailedFailures: FailedTest[] = [];
  const recapFailures: FailedTest[] = [];
  const filesByName = new Map<string, string | null>();
  let file: string | null = null;
  let reportedCount: number | null = null;
  for (const line of stderr.split("\n")) {
    const trimmed = stripAnsi(line).trim();
    if (/^# Unhandled error\b/u.test(trimmed)
      || /^\d+ errors?$/u.test(trimmed)) return null;
    const summary = trimmed.match(/^(\d+) tests? failed:$/u);
    if (summary !== null) {
      reportedCount = Number.parseInt(summary[1]!, 10);
      file = null;
      continue;
    }
    const match = trimmed.match(/^\(fail\) (.*?)(?: \[[\d.]+(?:ms|s)\])?$/u);
    if (reportedCount !== null) {
      if (match !== null) {
        const name = match[1]!;
        recapFailures.push({ file: filesByName.get(name) ?? null, name });
      }
      continue;
    }
    const headingText = trimmed.startsWith("::group::")
      ? trimmed.slice("::group::".length)
      : trimmed;
    const heading = headingText.match(/^(.+\.(?:[cm]?[jt]sx?)):$/u);
    if (heading !== null) {
      file = heading[1]!;
      continue;
    }
    if (trimmed.endsWith(":")) file = null;
    if (file === null || match === null) continue;
    const name = match[1]!;
    detailedFailures.push({ file, name });
    const knownFile = filesByName.get(name);
    filesByName.set(name, knownFile === undefined || knownFile === file
      ? file
      : null);
  }
  if (reportedCount === recapFailures.length) return recapFailures;
  return reportedCount === detailedFailures.length ? detailedFailures : null;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}
