/**
 * The parent-side launcher for one image normalization child process.
 *
 * `server/image-normalize-child.ts` holds the child body; this module
 * spawns it, feeds it bounded input, reads its bounded output, and enforces
 * the stage deadline and the memory limit from the outside. The phase
 * machine and the termination ladder below follow `shared/executable-probe.ts`
 * exactly: never settle on a bare `'error'` event, always wait for `close`,
 * and always end the whole child tree rather than only the direct pid. On
 * POSIX that means `process.kill(-pid, sig)` against the process group; on
 * Windows, which has no process group, it means `taskkill /T /F` against
 * the pid tree. Both matter here: a source checkout runs the child through
 * `tsx`, and `tsx` transforms TypeScript through a long-lived `esbuild`
 * service process it spawns as an unref'd grandchild. `esbuild` never marks
 * that grandchild `detached`, so on POSIX it inherits the child's process
 * group and dies with it; on Windows only `taskkill /T /F` reaches it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import {
  assignWindowsChildMemoryLimit,
  pollChildMemory,
  RSS_POLL_INTERVAL_MS
} from "./image-normalize-memory-bound.js";
import type { NormalizedImage } from "./image-normalize.js";

/**
 * What the design calls "a platform-enforced 512 MiB memory limit". How it
 * is enforced is different on each platform; both mechanisms live in
 * `server/image-normalize-memory-bound.ts`:
 * - On Windows the child is assigned to a Job Object with this many bytes as
 *   its `JOB_OBJECT_LIMIT_JOB_MEMORY` ceiling. That bound is enforced by the
 *   kernel: an allocation that would cross it fails inside the child,
 *   before this launcher does anything. See `assignWindowsChildMemoryLimit`.
 *   If that assignment does not succeed, `sendChildInput` below fails the
 *   whole stage closed rather than running the child unbounded.
 * - On Linux and macOS this launcher polls the child's own resident set
 *   size and kills its process group on breach. See `pollChildMemory`'s own
 *   comment for exactly what that does and does not guarantee, because a
 *   poll is not the same kind of bound as a Job Object.
 */
export const IMAGE_NORMALIZE_CHILD_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * The message on the `ServiceError` `sendChildInput` raises when
 * `assignWindowsChildMemoryLimit` resolves `false`. A Windows machine that
 * cannot install a Job Object cannot normalize an image under this design:
 * the kernel-enforced ceiling is the only bound this stage has on Windows
 * (see `assignWindowsChildMemoryLimit`'s own comment), so a child that
 * never received one must never receive Source Image bytes either. This
 * message is exported so `test/image-normalize.test.ts` can assert that a
 * failure it observes is NOT this one, proving a limit-hit failure is
 * distinct from an installation failure.
 */
export const WINDOWS_JOB_MEMORY_LIMIT_NOT_INSTALLED_MESSAGE =
  "The image normalization memory limit could not be installed on this Windows machine.";

const TERMINATION_GRACE_MS = 250;
const SETTLEMENT_DEADLINE_MS = 500;
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
    let rssTimer: ReturnType<typeof setTimeout> | undefined;

    const deadlineTimer = setTimeout(() => {
      beginTermination(new ServiceError(
        504,
        "Image normalization exceeded its time limit.",
        "image_normalization_failed"
      ));
    }, deadlineMs);

    /**
     * The POSIX memory poll reschedules itself with `setTimeout` after each
     * `pollChildMemory` call resolves, instead of running on a bare
     * `setInterval`. `pollChildMemory` spawns `ps` on macOS and reads a
     * `/proc` file on Linux; `setInterval` never waits for an async
     * callback to finish, so a `RSS_POLL_INTERVAL_MS` tick that is short
     * next to either cost can queue several polls in flight at once, up to
     * five concurrent `ps` processes for one stage. Rescheduling only after
     * the previous poll settles keeps exactly one in flight at a time.
     */
    function scheduleRssPoll(): void {
      rssTimer = setTimeout(() => {
        void pollChildMemory(child.pid!, memoryLimitBytes, beginTermination).finally(() => {
          if (phase === "running") scheduleRssPoll();
        });
      }, RSS_POLL_INTERVAL_MS);
    }
    if (posix && child.pid !== undefined) scheduleRssPoll();

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
      if (rssTimer !== undefined) clearTimeout(rssTimer);
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

    void sendChildInput();

    /**
     * On Windows, wait for the Job Object assignment to settle before
     * handing the child any Source Image bytes, closing the window between
     * spawn and a kernel-enforced ceiling actually being in place. On POSIX
     * this is skipped entirely, unchanged from before this bound existed.
     *
     * `assignWindowsChildMemoryLimit` resolves `false` for every failure
     * mode: a missing `powershell.exe`, a refusal, a timeout, all alike.
     * The design calls for a platform-enforced memory limit on Windows, not
     * a best-effort one, so a child that cannot be bounded must never
     * normalize. Sending it Source Image bytes anyway would let it decode
     * and hold that data completely unbounded, the exact failure class this
     * whole mechanism exists to remove. This function ends the stage with
     * `image_normalization_failed` instead and never writes to the child's
     * stdin.
     *
     * Before even attempting the assignment, refuse to spawn the helper at
     * all against a pid this launcher already knows is gone: `child.exitCode`
     * and `child.signalCode` are both non-null only after the child has
     * exited, and a gone pid is exactly the pid Windows is free to recycle
     * for an unrelated process. This is the cheap half of closing that race;
     * `assignWindowsChildMemoryLimit`'s own script closes the much larger
     * remaining window, the several seconds its `powershell.exe` helper
     * spends compiling, by re-checking the target process's identity itself
     * immediately before it opens a handle (see that function's comment).
     */
    async function sendChildInput(): Promise<void> {
      if (!posix && child.pid !== undefined) {
        if (child.exitCode !== null || child.signalCode !== null) {
          beginTermination(new ServiceError(
            500,
            WINDOWS_JOB_MEMORY_LIMIT_NOT_INSTALLED_MESSAGE,
            "image_normalization_failed"
          ));
          return;
        }
        const installed = await assignWindowsChildMemoryLimit(child.pid, memoryLimitBytes);
        if (!installed) {
          beginTermination(new ServiceError(
            500,
            WINDOWS_JOB_MEMORY_LIMIT_NOT_INSTALLED_MESSAGE,
            "image_normalization_failed"
          ));
          return;
        }
      }
      if (phase !== "running" || child.stdin === null) return;
      child.stdin.end(Buffer.from(sourceBytes));
    }

    function beginTermination(error: Error): void {
      if (phase !== "running") return;
      phase = "terminating";
      pendingError = error;
      clearTimeout(deadlineTimer);
      if (rssTimer !== undefined) clearTimeout(rssTimer);
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
      if (rssTimer !== undefined) clearTimeout(rssTimer);
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

/** End the whole child tree: the process group on POSIX, or the pid tree on
 *  Windows. No pid means nothing spawned; never call `child.kill` without a
 *  pid, which can deliver the signal to this process instead. */
function killChildTree(child: ChildProcess, signal: NodeJS.Signals, posix: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (posix) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Group already gone.
    }
    return;
  }
  killWindowsProcessTree(pid);
}

/**
 * Windows has no process group, so a bare `child.kill()` reaches only the
 * direct pid and leaves any descendant running, in particular the `esbuild`
 * transform service `tsx` spawns as an unref'd grandchild in a source
 * checkout (see the module comment above). `taskkill /T /F` walks the
 * Windows parent-process-id chain instead and force-ends the pid and every
 * descendant it finds, which is the Windows primitive for what
 * `process.kill(-pid, signal)` does for a POSIX process group.
 *
 * Node ignores the `signal` argument on Windows and force-kills regardless
 * (there is no graceful Windows signal to send), so `taskkill /F` is the
 * right call on both rungs of the termination ladder, not only the second
 * one.
 *
 * `taskkill` exits with a non-zero code when the pid is already gone. That
 * is the Windows analogue of the ESRCH the POSIX branch swallows above, so
 * `spawnSync` result is not checked; a failed lookup and a failed spawn (an
 * absent `taskkill`, recorded on `.error`) both mean the same thing here:
 * there is nothing left to terminate.
 */
function killWindowsProcessTree(pid: number): void {
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
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
 *  pixel bound implicitly caps (see `image-normalize-memory-bound.ts`) both
 *  have room under the same overall budget. Bun has no equivalent flag: it
 *  runs on JavaScriptCore, not V8, so this only ever applies under plain
 *  Node. */
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
