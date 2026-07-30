import { spawn, type ChildProcess } from "node:child_process";
import {
  parseBuildIdentity,
  type PackagedBuildIdentity
} from "./build-identity.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import type { BuiltArtifactTarget } from "./release-targets.js";

export const EXECUTABLE_PROBE_TIMEOUT_MS = 5_000;
export const EXECUTABLE_PROBE_MAX_STDOUT_BYTES = 64 * 1024;
/** Bounded SIGTERM→SIGKILL grace while reaping a probe process group. */
export const EXECUTABLE_PROBE_TERMINATION_GRACE_MS = 250;
/**
 * Final bound after SIGKILL of the probe process group. A setsid descendant that
 * keeps inherited stdout or stderr open must not hold the Promise (and any
 * install lock around it) past this deadline.
 */
export const EXECUTABLE_PROBE_SETTLEMENT_DEADLINE_MS = 500;

export class ExecutableProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecutableProbeError";
  }
}

/**
 * Runs Candidate --version --json with bounded stdout, drained stderr, timeout,
 * abort handling, and strict JSON parsing.
 *
 * Abort, timeout, stdout-bound, and spawn/process-error failures wait until the
 * spawned probe (and, on POSIX, its process group) is reaped and stdio is closed
 * before the Promise rejects, subject to a final settlement deadline after
 * process-group termination. A setsid descendant that keeps inherited pipes open
 * cannot hold the Promise past that deadline: owned streams are closed and the
 * Promise settles. Callers that hold a mutation lock around a probe therefore
 * release within a bound even when a descendant escapes the process group.
 */
export async function readReleaseExecutableIdentity(
  executablePath: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}
): Promise<PackagedBuildIdentity> {
  const raw = await runVersionJson(executablePath, options);
  let identity: ReturnType<typeof parseBuildIdentity>;
  try {
    identity = parseBuildIdentity(raw);
  } catch (error) {
    throw new ExecutableProbeError("Executable build identity is invalid", { cause: error });
  }
  if (identity.product !== "1667") {
    throw new ExecutableProbeError("Executable product is not 1667");
  }
  if (identity.artifactTarget === "source" || identity.buildKind !== "release") {
    throw new ExecutableProbeError("Executable is not a release build");
  }
  return identity;
}

/**
 * Proves a Candidate matches one exact release version and target.
 */
export async function probeReleaseExecutable(
  executablePath: string,
  expected: {
    readonly version: string;
    readonly artifactTarget: BuiltArtifactTarget;
  },
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  } = {}
): Promise<PackagedBuildIdentity> {
  const identity = await readReleaseExecutableIdentity(executablePath, options);
  if (identity.productVersion !== expected.version
    || identity.artifactTarget !== expected.artifactTarget) {
    throw new ExecutableProbeError("Executable identity did not match the selected release");
  }
  return identity;
}

async function runVersionJson(
  executablePath: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }
): Promise<unknown> {
  const signal = options.signal;
  const timeoutMs = options.timeoutMs ?? EXECUTABLE_PROBE_TIMEOUT_MS;
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExecutableProbeError("Executable probe was interrupted"));
      return;
    }

    // Own process group on POSIX so abort/timeout can SIGTERM/SIGKILL the whole
    // tree (probe + descendants that inherit stdio). Never unref: we wait for close.
    const posix = process.platform !== "win32";
    const child = spawn(executablePath, ["--version", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: "C",
        LC_ALL: "C"
      }
    });

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    // running → terminating (kill + wait close) → settled (promise done, no timers).
    let phase: "running" | "terminating" | "settled" = "running";
    let pendingError: Error | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      beginTermination(new ExecutableProbeError("Executable probe timed out"));
    }, timeoutMs);
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      beginTermination(new ExecutableProbeError("Executable probe was interrupted"));
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (phase !== "running") return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > EXECUTABLE_PROBE_MAX_STDOUT_BYTES) {
        beginTermination(
          new ExecutableProbeError("Executable probe stdout exceeded the bound")
        );
        return;
      }
      stdout.push(chunk);
    });
    // Drain stderr so a verbose Candidate cannot fill the pipe and hang.
    child.stderr?.on("data", () => undefined);

    // Never settle on 'error': Node emits 'close' after 'error' when a ChildProcess
    // handle exists (including spawn failure). Record the reason and wait for close
    // so termination always reaps before the Promise settles (until the final
    // settlement deadline after process-group kill).
    child.on("error", (error) => {
      if (phase === "settled") return;
      if (phase === "terminating") {
        // Keep the original termination reason; close or settlement deadline settles.
        return;
      }
      beginTermination(new ExecutableProbeError(`Executable probe failed: ${error.message}`, {
        cause: error
      }));
    });

    child.on("close", (code) => {
      if (phase === "settled") return;
      if (phase === "terminating") {
        settle(pendingError ?? new ExecutableProbeError("Executable probe was interrupted"));
        return;
      }
      if (code !== 0) {
        settle(new ExecutableProbeError("Executable version probe failed"));
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8").trim();
      try {
        settle(null, parseJsonRejectingDuplicateKeys(text));
      } catch (error) {
        settle(new ExecutableProbeError("Executable version probe returned invalid JSON", {
          cause: error
        }));
      }
    });

    // Register abort after close/error listeners, then re-check: abort can land
    // between the initial aborted check and addEventListener and would miss the
    // event if we only listened once. Re-check must not run before close is wired.
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }

    function beginTermination(error: Error): void {
      if (phase !== "running") return;
      phase = "terminating";
      pendingError = error;
      // Drop the wall-clock timer; abort listener must not fire again after settle.
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      killProbeTree(child, "SIGTERM", posix);
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (phase !== "terminating") return;
        killProbeTree(child, "SIGKILL", posix);
        // After process-group termination, bound wait for close. A setsid
        // descendant that retains inherited pipes must not keep this Promise open.
        settlementTimer = setTimeout(() => {
          settlementTimer = undefined;
          if (phase !== "terminating") return;
          closeOwnedStreams(child);
          settle(pendingError ?? new ExecutableProbeError("Executable probe was interrupted"));
        }, EXECUTABLE_PROBE_SETTLEMENT_DEADLINE_MS);
      }, EXECUTABLE_PROBE_TERMINATION_GRACE_MS);
    }

    function settle(error: Error | null, value?: unknown): void {
      if (phase === "settled") return;
      phase = "settled";
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (settlementTimer !== undefined) {
        clearTimeout(settlementTimer);
        settlementTimer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      if (error !== null) reject(error);
      else resolve(value);
    }
  });
}

/** Close only the stdio pipes this probe owns; never touch the child stdin. */
function closeOwnedStreams(child: ChildProcess): void {
  for (const stream of [child.stdout, child.stderr] as const) {
    if (stream === null || stream === undefined) continue;
    try {
      stream.destroy();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Signal the probe process group on POSIX (leader pid), else the child alone.
 * Descendants that inherit stdio must die before Node emits close.
 * No pid (spawn failure) means nothing to signal — never call child.kill without
 * a pid; Node can deliver the signal to this process instead.
 */
function killProbeTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  posix: boolean
): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (posix) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Group already gone or not yet session-leader; fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped.
  }
}
