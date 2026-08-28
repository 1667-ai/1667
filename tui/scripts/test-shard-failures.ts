export interface FailedTest {
  readonly file: string | null;
  readonly name: string;
}

type DetailedFailedTest = FailedTest & { readonly file: string };

export function parseFailures(stderr: string): readonly FailedTest[] | null {
  const detailedFailures: DetailedFailedTest[] = [];
  const recapNames: string[] = [];
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
        recapNames.push(match[1]!);
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
  }
  if (reportedCount === recapNames.length) {
    return recapNames.map((name) => ({
      file: detailedFile(name, detailedFailures, recapNames),
      name
    }));
  }
  return reportedCount === detailedFailures.length ? detailedFailures : null;
}

function detailedFile(
  name: string,
  detailed: readonly DetailedFailedTest[],
  recapNames: readonly string[]
): string | null {
  const candidates = detailed.filter((failure) => failure.name === name);
  const recapCount = recapNames.filter((candidate) => candidate === name).length;
  const file = candidates[0]?.file;
  return file !== undefined && candidates.length === recapCount
      && candidates.every((failure) => failure.file === file)
    ? file
    : null;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}
