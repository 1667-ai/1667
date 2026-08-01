import { spawn, type ChildProcess } from "node:child_process";
import { RELEASE_TRANSFER_TOTAL_TIMEOUT_MS } from "../shared/release-artifact-bounds.js";

export interface InstallUpgradeE2eOptions {
  fromVersion: string;
  fromChannel: "beta" | "stable";
  homepageUrl: string;
  currentUrl: string;
  previousUrl: string;
}

/**
 * The Shell Installer gives one archive transfer the full product budget, so a
 * slow but legal download must not fail the gate. The extra interval covers
 * extraction and the build identity probe that follow the transfer.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = RELEASE_TRANSFER_TOTAL_TIMEOUT_MS + 120_000;

/** An installer script is small, so it gets a much shorter budget. */
export const FETCH_TIMEOUT_MS = 60_000;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string | Buffer;
}

interface RawResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/**
 * Every command runs in its own process group. The Shell Installer runs `curl`
 * in the background, so a signal that reaches only the immediate child leaves a
 * download running against its own deadline. That orphan can write into a
 * scratch directory after the gate removes it.
 */
const activeChildren = new Set<ChildProcess>();

function terminateGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone, which is the state this asks for.
  }
}

/** Ends every running command group. The caller waits for the command promises
 *  to settle before it removes the scratch directory. */
export function terminateActiveCommands(): void {
  for (const child of activeChildren) {
    terminateGroup(child, "SIGKILL");
  }
}

function spawnCollect(
  file: string,
  args: readonly string[],
  options: CommandOptions
): Promise<RawResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
    });
    activeChildren.add(child);

    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    let timedOut = false;
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateGroup(child, "SIGKILL");
    }, timeoutMs);

    if (options.input !== undefined && child.stdin !== null) {
      // A command that rejects the script exits before it drains the pipe. The
      // resulting EPIPE is that command's failure, reported through its exit
      // code, so it must not become an unhandled stream error.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }

    // `close` fires after the process exits and its pipes end, so settling here
    // reaps the command before the caller cleans up after it.
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      if (timedOut) {
        reject(new Error(`Command '${file} ${args.join(" ")}' timed out after ${timeoutMs}ms`));
        return;
      }
      if (failure !== null) {
        reject(failure);
        return;
      }
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks), stderr });
    });

    child.on("error", (error) => {
      failure = error;
      if (child.pid === undefined) {
        clearTimeout(timer);
        activeChildren.delete(child);
        reject(error);
      }
    });
  });
}

export async function execProcess(
  file: string,
  args: readonly string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  const result = await spawnCollect(file, args, options);
  // Decoding once keeps a multi-byte character that spans two chunks intact.
  return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
}

export async function fetchBytes(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Buffer> {
  const result = await spawnCollect(
    "curl",
    ["-fsSL", "--connect-timeout", "15", "--max-time", "45", url],
    { timeoutMs }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to download URL: ${url} (curl exit code ${result.exitCode})\n${result.stderr}`
    );
  }
  return result.stdout;
}
