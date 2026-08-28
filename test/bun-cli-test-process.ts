import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STARTUP_TIMEOUT = "Embedded backend did not become ready within 60000 ms";
const MAX_ATTEMPTS = 3;

interface BunCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

export async function runBunCli(
  args: readonly string[],
  options: BunCliOptions = {}
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const bun = process.execPath.includes("bun") ? process.execPath : "bun";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await execFileAsync(bun, [...args], { ...options, encoding: "utf8" });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isBackendStartupTimeout(error)) throw error;
      process.stderr.write(
        `Bun CLI backend startup timed out; retrying in a fresh process (${attempt}/${MAX_ATTEMPTS})\n`
      );
    }
  }
  throw new Error("Bun CLI retry loop ended without a result");
}

function isBackendStartupTimeout(error: unknown): boolean {
  return error instanceof Error
    && "stderr" in error
    && String(error.stderr).includes(STARTUP_TIMEOUT);
}
