/**
 * The parent-side launcher for one image normalization child process.
 *
 * `server/image-normalize-child.ts` holds the child body; this module
 * spawns it, feeds it bounded input, reads its bounded output, and enforces
 * the stage deadline and the memory limit from the outside. The phase
 * machine, the termination ladder, and the `process.kill(-pid, sig)`
 * process-group discipline below follow `shared/executable-probe.ts`
 * exactly: never settle on a bare `'error'` event, always wait for `close`,
 * and always signal the process group rather than the single child pid.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  IMAGE_STAGE_DEADLINE_MS,
  MAX_IMAGE_OBJECT_BYTES,
  type StoredImageMediaType
} from "../shared/image-attachment.js";
import {
  NORMALIZE_IMAGE_CHILD_FLAG,
  type ChildResultMessage
} from "./image-normalize-child.js";
import { ServiceError, type ServiceErrorCode } from "./errors.js";
import type { NormalizedImage } from "./image-normalize.js";

/** What the design calls "a platform-enforced 512 MiB memory limit". On
 *  Linux this launcher enforces it by polling the child's own resident set
 *  size and killing its process group on breach; see the module comment on
 *  `pollChildMemory` for exactly what that does and does not guarantee. */
export const IMAGE_NORMALIZE_CHILD_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

const TERMINATION_GRACE_MS = 250;
const SETTLEMENT_DEADLINE_MS = 500;
const RSS_POLL_INTERVAL_MS = 200;
const MAX_CHILD_STDERR_BYTES = 8_192;

export interface LaunchImageNormalizeChildOptions {
  readonly deadlineMs?: number;
  readonly memoryLimitBytes?: number;
  /** Test-only: hold the child's single thread busy for this many
   *  milliseconds before it touches the image, so a test can prove the
   *  deadline kills a process stuck in synchronous work. Production
   *  callers never set this. */
  readonly debugStallMs?: number;
  /** Test-only: make the child retain this many megabytes instead of
   *  normalizing, so a test can prove the memory watchdog independently of
   *  real decode and encode work. Production callers never set this. */
  readonly debugAllocateMb?: number;
}

/**
 * Normalize one Source Image in a fresh, bounded child process, and return
 * the Normalized Image. Every failure this function reports is a
 * `ServiceError` carrying one of `image_type_not_supported`,
 * `image_invalid`, `image_source_too_large`, or `image_normalization_failed`.
 */
export async function launchImageNormalizeChild(
  sourceBytes: Uint8Array,
  declaredMediaType: string | undefined,
  options: LaunchImageNormalizeChildOptions = {}
): Promise<NormalizedImage> {
  const deadlineMs = options.deadlineMs ?? IMAGE_STAGE_DEADLINE_MS;
  const memoryLimitBytes = options.memoryLimitBytes
    ?? IMAGE_NORMALIZE_CHILD_MEMORY_LIMIT_BYTES;
  const { command, args } = childSpawnCommand(declaredMediaType, memoryLimitBytes);
  const posix = process.platform !== "win32";

  return await new Promise<NormalizedImage>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      detached: posix,
      env: childEnvironment(options)
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let resultMessage: ChildResultMessage | null = null;

    // running -> terminating (kill + wait close) -> settled (promise done).
    let phase: "running" | "terminating" | "settled" = "running";
    let pendingError: Error | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;

    const deadlineTimer = setTimeout(() => {
      beginTermination(new ServiceError(
        504,
        "Image normalization exceeded its time limit.",
        "image_normalization_failed"
      ));
    }, deadlineMs);

    const rssTimer = posix && child.pid !== undefined
      ? setInterval(() => {
          void pollChildMemory(child.pid!, memoryLimitBytes, beginTermination);
        }, RSS_POLL_INTERVAL_MS)
      : undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (phase !== "running") return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_IMAGE_OBJECT_BYTES) {
        beginTermination(new ServiceError(
          422,
          "Image normalization produced output over the size limit.",
          "image_normalization_failed"
        ));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_CHILD_STDERR_BYTES) return;
      const take = chunk.subarray(0, MAX_CHILD_STDERR_BYTES - stderrBytes);
      stderrChunks.push(take);
      stderrBytes += take.byteLength;
    });
    child.on("message", (value: unknown) => {
      resultMessage = decodeChildResultMessage(value);
    });

    child.once("error", (error) => {
      if (phase === "settled") return;
      if (phase === "terminating") return;
      beginTermination(new ServiceError(
        500,
        "The image normalization process could not start.",
        "image_normalization_failed",
        { cause: error }
      ));
    });

    child.once("close", (code) => {
      clearTimeout(deadlineTimer);
      if (rssTimer !== undefined) clearInterval(rssTimer);
      if (phase === "settled") return;
      if (phase === "terminating") {
        settle(pendingError ?? new ServiceError(
          500,
          "Image normalization was interrupted.",
          "image_normalization_failed"
        ));
        return;
      }
      settle(outcomeError(resultMessage, stderrChunks, stderrBytes));
    });

    if (child.stdin !== null) {
      child.stdin.end(Buffer.from(sourceBytes));
    }

    function beginTermination(error: Error): void {
      if (phase !== "running") return;
      phase = "terminating";
      pendingError = error;
      clearTimeout(deadlineTimer);
      if (rssTimer !== undefined) clearInterval(rssTimer);
      killChildTree(child, "SIGTERM", posix);
      graceTimer = setTimeout(() => {
        graceTimer = undefined;
        if (phase !== "terminating") return;
        killChildTree(child, "SIGKILL", posix);
        settlementTimer = setTimeout(() => {
          settlementTimer = undefined;
          if (phase !== "terminating") return;
          settle(pendingError ?? new ServiceError(
            500,
            "Image normalization was interrupted.",
            "image_normalization_failed"
          ));
        }, SETTLEMENT_DEADLINE_MS);
      }, TERMINATION_GRACE_MS);
    }

    function settle(error: Error | null): void {
      if (phase === "settled") return;
      phase = "settled";
      clearTimeout(deadlineTimer);
      if (rssTimer !== undefined) clearInterval(rssTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      if (error !== null) {
        reject(error);
        return;
      }
      const message = resultMessage;
      if (message === null || !message.ok) {
        reject(new ServiceError(
          422,
          "The image could not be normalized.",
          "image_normalization_failed"
        ));
        return;
      }
      const bytes = Buffer.concat(stdoutChunks);
      if (bytes.byteLength !== message.byteLength) {
        reject(new ServiceError(
          500,
          "The normalized image output did not match its reported size.",
          "image_normalization_failed"
        ));
        return;
      }
      resolve({
        mediaType: message.mediaType,
        width: message.width,
        height: message.height,
        bytes
      });
    }
  });
}

/**
 * The success or failure the child reported, when it reported one at all.
 * `settle` re-checks a reported success against the bytes actually received,
 * so this only needs to turn a reported failure into the `ServiceError` it
 * describes, and to name the one outcome a child cannot describe: ending
 * with no result at all.
 */
function outcomeError(
  message: ChildResultMessage | null,
  stderrChunks: readonly Buffer[],
  stderrBytes: number
): Error | null {
  if (message !== null) {
    return message.ok ? null : new ServiceError(422, message.message, message.code);
  }
  return new ServiceError(
    500,
    "The image normalization process ended without a result.",
    "image_normalization_failed",
    stderrBytes > 0 ? { cause: new Error(Buffer.concat(stderrChunks).toString("utf8")) } : {}
  );
}

/**
 * Read one Source Image's worth of resident memory from `/proc/<pid>/status`
 * and kill the child's process group when it crosses `limitBytes`.
 *
 * This is a polling, best-effort watchdog, not a kernel-enforced ceiling.
 * Two harder mechanisms were tried and rejected during this slice: setting
 * `RLIMIT_AS` (the POSIX `ulimit -v` virtual-memory cap) on the child made
 * Node itself fail to start with "Fatal process out of memory: Failed to
 * reserve virtual memory for CodeRange", because V8 reserves address space
 * for its own startup (code range, pointer-compression cage) far past 512
 * MiB before any image code runs; and a Linux cgroup v2 `memory.max` limit
 * needs a cgroup subtree this process can create and move a child into,
 * which is only available when the process launching 1667 already lives
 * inside a delegated subtree (a systemd `--user` unit, for example) and is
 * not available from an interactive login session's own cgroup on this
 * development machine. Neither exists in this repository already, and
 * building a cgroup helper that silently does nothing on most developer
 * machines would be worse than being honest about a polling watchdog.
 *
 * So what actually bounds a normalization's memory:
 * - The header parser (`server/image-header.ts`) refuses any Source Image
 *   over the shared pixel and byte limits before photon ever decodes it,
 *   which bounds the raw RGBA raster to a known maximum regardless of this
 *   watchdog.
 * - On Node, the child is launched with `--max-old-space-size`, which bounds
 *   V8's own JS heap; it does not bound WASM linear memory.
 * - This watchdog polls `/proc/<pid>/status` every `RSS_POLL_INTERVAL_MS`
 *   and kills the process group on the first sample over the limit. A very
 *   fast single allocation could in principle spike and free memory between
 *   two polls without ever being observed; the pixel bound above is what
 *   keeps that gap small in practice.
 * - Linux only. macOS needs its own primitive (a Job-Object-style API does
 *   not exist there either); Windows needs a Job Object, the same mechanism
 *   the design already calls for around the clipboard image helper. Neither
 *   is implemented in this slice; both are out of reach of this Linux
 *   development machine and are proven by the packaged CI matrix instead,
 *   the same way the dependency gate itself is.
 */
async function pollChildMemory(
  pid: number,
  limitBytes: number,
  beginTermination: (error: Error) => void
): Promise<void> {
  if (process.platform !== "linux") return;
  let rssBytes: number | null;
  try {
    rssBytes = await readProcessRssBytes(pid);
  } catch {
    return;
  }
  if (rssBytes !== null && rssBytes > limitBytes) {
    beginTermination(new ServiceError(
      422,
      "Image normalization exceeded its memory limit.",
      "image_normalization_failed"
    ));
  }
}

async function readProcessRssBytes(pid: number): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(`/proc/${pid}/status`, "utf8");
  } catch {
    return null;
  }
  const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(text);
  if (match === null) return null;
  const kilobytes = Number(match[1]);
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

/** Signal the child's process group on POSIX, or the child alone on
 *  Windows. No pid means nothing spawned; never call `child.kill` without a
 *  pid, which can deliver the signal to this process instead. */
function killChildTree(child: ChildProcess, signal: NodeJS.Signals, posix: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (posix) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Group already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already reaped.
  }
}

function decodeChildResultMessage(value: unknown): ChildResultMessage | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    if (typeof record.mediaType !== "string"
      || (record.mediaType !== "image/png" && record.mediaType !== "image/jpeg")
      || typeof record.width !== "number"
      || typeof record.height !== "number"
      || typeof record.byteLength !== "number") {
      return null;
    }
    return {
      ok: true,
      mediaType: record.mediaType as StoredImageMediaType,
      width: record.width,
      height: record.height,
      byteLength: record.byteLength
    };
  }
  if (record.ok === false) {
    if (typeof record.code !== "string" || typeof record.message !== "string") return null;
    return { ok: false, code: record.code as ServiceErrorCode, message: record.message };
  }
  return null;
}

/**
 * Choose how to reach `server/image-normalize-child.ts` in a fresh process.
 *
 * A compiled 1667 executable has no separate file for this module: it is
 * bundled into the single binary the same way `server/worker.ts` is (see
 * `tui/scripts/build-standalone.ts`). Source-mode detection follows
 * `tui/src/serve-supervisor.ts` exactly: when the currently running
 * process's own entry ends in `.ts`, this is a source checkout, and the
 * child is spawned by file path (through `tsx` under plain Node, or
 * directly under Bun, which runs `.ts` natively). Otherwise this process is
 * itself a compiled or embedded build, and the child is spawned with only
 * the flag; reaching the child body then depends on the compiled entry
 * recognizing `NORMALIZE_IMAGE_CHILD_FLAG` the way it already recognizes
 * `--supervised-serve-child`, which is one line this module does not own
 * and does not add.
 */
function childSpawnCommand(
  declaredMediaType: string | undefined,
  memoryLimitBytes: number
): { readonly command: string; readonly args: readonly string[] } {
  const trailing = declaredMediaType === undefined
    ? [NORMALIZE_IMAGE_CHILD_FLAG]
    : [NORMALIZE_IMAGE_CHILD_FLAG, "--media-type", declaredMediaType];
  const entry = process.argv[1];
  const sourceMode = entry?.endsWith(".ts") === true;
  if (!sourceMode) {
    return { command: process.execPath, args: trailing };
  }
  const childEntry = fileURLToPath(
    new URL("./image-normalize-child.js", import.meta.url)
  ).replace(/\.js$/u, ".ts");
  if (process.versions.bun !== undefined) {
    return { command: process.execPath, args: [childEntry, ...trailing] };
  }
  return {
    command: process.execPath,
    args: nodeMemoryFlags(memoryLimitBytes).concat(["--import", "tsx", childEntry, ...trailing])
  };
}

/** V8's own JS heap ceiling for the child, on Node. Set below the full
 *  memory limit so the JS heap and the WASM linear memory the header's
 *  pixel bound implicitly caps (see `pollChildMemory` above) both have room
 *  under the same overall budget. Bun has no equivalent flag: it runs on
 *  JavaScriptCore, not V8, so this only ever applies under plain Node. */
function nodeMemoryFlags(memoryLimitBytes: number): string[] {
  const megabytes = Math.floor((memoryLimitBytes / (1024 * 1024)) * 0.7);
  return [`--max-old-space-size=${megabytes}`];
}

function childEnvironment(
  options: LaunchImageNormalizeChildOptions
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: "C",
    LC_ALL: "C"
  };
  if (options.debugStallMs !== undefined) {
    environment.AI_1667_IMAGE_NORMALIZE_TEST_STALL_MS = String(options.debugStallMs);
  }
  if (options.debugAllocateMb !== undefined) {
    environment.AI_1667_IMAGE_NORMALIZE_TEST_ALLOCATE_MB = String(options.debugAllocateMb);
  }
  return environment;
}
