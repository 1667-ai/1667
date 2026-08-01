import { rm } from "node:fs/promises";

const REMOVE_ATTEMPTS = 50;
const REMOVE_RETRY_MS = 100;

/** A smoke that never reported an exit, as opposed to one that failed. */
export class StandaloneSmokeTimeout extends Error {
  constructor(executable: string, timeoutMs: number) {
    super(`Standalone smoke timed out after ${timeoutMs}ms: ${executable}`);
    this.name = "StandaloneSmokeTimeout";
  }
}

export async function runStandalone(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs = 30_000
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}> {
  const started = performance.now();
  const child = Bun.spawn(
    [executable, ...args],
    { cwd, env, stdout: "pipe", stderr: "pipe" }
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut) {
    throw new StandaloneSmokeTimeout(executable, timeoutMs);
  }
  return {
    exitCode,
    stdout,
    stderr,
    elapsedMs: performance.now() - started
  };
}

export async function removeSmokeTree(target: string): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRemovalContention(error)
        || attempt + 1 === REMOVE_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, REMOVE_RETRY_MS));
    }
  }
}

function isRemovalContention(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (
      error.code === "EBUSY"
      || error.code === "EPERM"
      || error.code === "ENOTEMPTY"
    );
}
