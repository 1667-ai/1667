/**
 * Shared reading of the GitHub release workflow for the tests that assert its
 * shape. One reader, so a test file cannot drift from the workflow the other
 * test files read.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PRERELEASE_VERSION = "0.1.0-rc.1";
export const WORKFLOW = readFileSync(
  path.join(REPOSITORY_ROOT, ".github", "workflows", "release-github.yml"),
  "utf8"
);
export const RELEASE_ASSETS_CLI = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "release-github-assets.ts"
);

/**
 * The workflow's jobs, each as the block of text between its own header and the
 * next one. Enough to ask which job holds which permission and which commands
 * it runs.
 */
export function workflowJobs(): ReadonlyMap<string, string> {
  const body = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"));
  const headers = [...body.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)];
  const jobs = new Map<string, string>();
  headers.forEach((header, index) => {
    const start = header.index;
    const end = index + 1 < headers.length ? headers[index + 1]!.index : body.length;
    jobs.set(header[1]!, body.slice(start, end));
  });
  return jobs;
}
