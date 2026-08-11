/**
 * The three platform-specific ways `server/image-normalize-launcher.ts`
 * bounds the normalizer child's memory, split out of that file to keep it
 * under the repository's line-count guidance.
 *
 * - Windows: `assignWindowsChildMemoryLimit` assigns the child to a Job
 *   Object with a committed-memory ceiling. The kernel itself refuses any
 *   allocation that would cross it, a genuine enforced bound.
 * - Linux and macOS: `pollChildMemory` polls the child's own resident set
 *   size and kills its process group on breach. See that function's own
 *   comment for exactly what a poll does and does not guarantee, because it
 *   is not the same kind of bound as a Job Object.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  WINDOWS_JOB_MEMORY_LIMIT_POWERSHELL_SOURCE,
  WINDOWS_JOB_MEMORY_LIMIT_SUCCESS_MARKER,
  WINDOWS_JOB_OBJECT_PROCESS_ACCESS
} from "../shared/windows-job-memory-limit.js";
import { ServiceError } from "./errors.js";

export const RSS_POLL_INTERVAL_MS = 200;

/**
 * How long `assignWindowsChildMemoryLimit` waits for its `powershell.exe`
 * helper before it gives up and reports the limit as not installed.
 *
 * This has to cover two costs, not one: `powershell.exe -NoProfile` itself
 * starting, and then `Add-Type -MemberDefinition`, which invokes the C#
 * compiler the first time this process runs any P/Invoke code. That compile
 * routinely takes 1 to 2 seconds on its own, and longer on a CPU-contended
 * CI runner. The previous value, 3000 ms, was the same order of magnitude
 * as the compile alone, before process startup even ran. Because the
 * launcher now fails the whole stage closed on any `false` result (see
 * `sendChildInput` in `server/image-normalize-launcher.ts`), a timeout that
 * fires on an otherwise healthy machine does not degrade gracefully; it
 * fails image staging outright. 15000 ms gives several times the ordinary
 * compile cost as headroom, while still leaving most of the 60-second
 * `IMAGE_STAGE_DEADLINE_MS` for the normalization work this assignment
 * gates.
 *
 * This cost is paid again for every staged image, not once per process.
 * Each call to `assignWindowsChildMemoryLimit` spawns a fresh
 * `powershell.exe`, so `Add-Type` recompiles from source every time rather
 * than once per `powershell.exe` lifetime, and `server/image-stage-permit.ts`
 * serializes staging process-wide, one image at a time, so this 1-to-2-second
 * compile sits directly ahead of each image's real normalization work on an
 * interactive path.
 *
 * The review that raised this also suggested one long-lived helper process
 * that owns a Job Object and takes pids to assign over stdin, paying the
 * compile once per 1667 process instead of once per image. This module does
 * not build that helper, for two reasons. First, a persistent helper adds a
 * second process lifecycle to manage on Windows specifically, the one
 * platform nobody working on this change can run directly: restart after a
 * crash, orphan cleanup if the parent process ends first, and a
 * request/response protocol over stdin that has to stay correct under
 * concurrent callers, none of which can be exercised end to end from this
 * environment. Second, `IMAGE_INPUT_ACTIVATED` still gates this whole
 * feature closed, so no user-facing traffic pays this cost yet. The
 * per-image cost this leaves in place is bounded and named here rather than
 * hidden: about 1 to 2 seconds of `Add-Type` compilation per staged image,
 * against a 60-second stage deadline. If staged-image volume, or a measured
 * cost from real Windows hardware, makes that unacceptable once this ships,
 * build the long-lived helper then, against a real number instead of an
 * estimate.
 */
const WINDOWS_JOB_ASSIGN_TIMEOUT_MS = 15_000;

/**
 * Read one Source Image's worth of resident memory and kill the child's
 * process group when it crosses `limitBytes`. Linux reads `VmRSS` from
 * `/proc/<pid>/status`; macOS has no `/proc`, so it reads the same
 * resident-set figure from `ps -o rss= -p <pid>` instead. Windows never
 * reaches this function: `assignWindowsChildMemoryLimit` gives it a real
 * Job Object ceiling instead of a poll, so the caller only arms this poll
 * for `posix` platforms in the first place (see the `rssTimer` in
 * `launchImageNormalizeChild`).
 *
 * This is a polling, best-effort watchdog, not a kernel-enforced ceiling.
 * Two harder mechanisms were tried and rejected for the POSIX platforms
 * during the first round: setting `RLIMIT_AS` (the POSIX `ulimit -v`
 * virtual-memory cap) on the child made Node itself fail to start with
 * "Fatal process out of memory: Failed to reserve virtual memory for
 * CodeRange", because V8 reserves address space for its own startup (code
 * range, pointer-compression cage) measured in gigabytes, far past any
 * ceiling this design could pick, before any image code runs; and a Linux
 * cgroup v2 `memory.max` limit needs a cgroup subtree this
 * process can create and move a child into, which is only available when
 * the process launching 1667 already lives inside a delegated subtree (a
 * systemd `--user` unit, for example) and is not available from an
 * interactive login session's own cgroup on a typical development machine.
 * Building a cgroup helper that silently does nothing on most developer
 * machines would be worse than being honest about a polling watchdog. macOS
 * has no comparable job-control primitive at all, so the same poll-and-kill
 * shape is the best available bound there too.
 *
 * So what actually bounds a normalization's memory on Linux and macOS:
 * - The header parser (`server/image-header.ts`) refuses any Source Image
 *   over the shared pixel and byte limits before photon ever decodes it,
 *   which bounds the raw RGBA raster to a known maximum regardless of this
 *   watchdog.
 * - On Node, the child is launched with `--max-old-space-size`, which bounds
 *   V8's own JS heap; it does not bound WASM linear memory.
 * - This watchdog polls every `RSS_POLL_INTERVAL_MS` and kills the process
 *   group on the first sample over the limit. A very fast single allocation
 *   could in principle spike and free memory between two polls without ever
 *   being observed; the pixel bound above is what keeps that gap small in
 *   practice. This is proven by execution: `test/image-normalize.test.ts`
 *   runs this watchdog for real on both platforms in the packaged CI matrix.
 */
export async function pollChildMemory(
  pid: number,
  limitBytes: number,
  beginTermination: (error: Error) => void
): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  let rssBytes: number | null;
  try {
    rssBytes = process.platform === "linux"
      ? await readLinuxRssBytes(pid)
      : await readMacosRssBytes(pid);
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

async function readLinuxRssBytes(pid: number): Promise<number | null> {
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

/** `ps -o rss= -p <pid>` prints the resident set size in KiB, with no
 *  header line because of the trailing `=` on the format keyword. A pid
 *  that has already exited makes `ps` exit non-zero with empty output,
 *  which resolves to `null`, the same "nothing to read" outcome the Linux
 *  reader's `ENOENT` catch above produces for a gone process. */
async function readMacosRssBytes(pid: number): Promise<number | null> {
  const output = await new Promise<string | null>((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: RSS_POLL_INTERVAL_MS * 5
    }, (error, stdout) => resolve(error === null ? stdout : null));
  });
  if (output === null) return null;
  const kilobytes = Number(output.trim());
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

/**
 * Assign the already-spawned normalizer child, by process id, to a fresh
 * Windows Job Object with a committed-memory ceiling, and report whether
 * the limit actually took effect. This is the same kernel primitive
 * `tui/src/clipboard-windows.ts` uses for its own helper, shared through
 * `shared/windows-job-memory-limit.ts`; the only difference is which
 * process the job targets, the current process there against a separate,
 * named process here. Once assigned, Windows itself refuses any allocation
 * that would push the child's committed memory past `limitBytes`. That is a
 * genuine kernel-enforced ceiling, not a poll: no `pollChildMemory` call is
 * ever armed for Windows (see the `rssTimer` in `launchImageNormalizeChild`,
 * gated to `posix`).
 *
 * The returned promise resolves `true` only when the script's stdout is
 * exactly `WINDOWS_JOB_MEMORY_LIMIT_SUCCESS_MARKER`, which the script prints
 * itself, and only after `Set-JobMemoryLimit` reports both native calls
 * succeeded. Every other outcome resolves `false`: a missing `powershell.exe`
 * (the process cannot even spawn), a non-zero exit, a timeout, or a script
 * that ran to completion but whose Job Object calls returned false. This
 * function does not try to tell those apart. A Windows machine that cannot
 * install a job object cannot normalize an image under this design, so the
 * caller (`launchImageNormalizeChild`) fails closed on any `false` alike,
 * before it ever hands the child a Source Image byte; distinguishing the
 * cause further would not change that outcome, only the diagnostic text.
 *
 * There is a short window between the child's own process start and a
 * successful assignment; the caller closes it by holding the child's
 * stdin, and therefore its Source Image bytes, until this settles, and by
 * refusing to send them at all when this resolves `false` (see
 * `sendChildInput` in `launchImageNormalizeChild`).
 *
 * The `Add-Type` compile above is also where the identity risk lives.
 * `OpenProcess` and `AssignProcessToJobObject` run only after that compile,
 * one to two seconds after the script starts, several seconds after the
 * caller spawned the target pid. If the target process died in that window,
 * Windows can recycle its pid for an unrelated process before this script
 * ever calls `OpenProcess`, and a bare pid check has nothing left to catch
 * it: the wrong process would be assigned to the job, with this call's
 * memory ceiling applied to it, and a `PROCESS_TERMINATE` handle would be
 * held on it for the rest of this stage's termination ladder.
 *
 * The script below closes the dominant part of that window by reading the
 * target process's own `StartTime` twice: once as its very first
 * statement, before `Add-Type` runs, and once again immediately before
 * `OpenProcess`, after the compile. `Get-Process` needs no P/Invoke and no
 * compile, so the first reading happens as early as `powershell.exe`'s own
 * cold start allows, ahead of the multi-second cost this function's own
 * timeout comment describes. The two readings must name the same process
 * and report the exact same start time, down to the tick, or the script
 * exits without ever calling `OpenProcess`. A process that has exited
 * between spawn and this script's very first line, before either reading
 * happens, is caught the same way: `Get-Process` returns nothing for a
 * gone pid, and a null first reading also exits early. The residual risk
 * this does not close is a pid recycled inside the short gap between the
 * caller's own spawn and this script's cold start, which is much smaller
 * than the compile-sized window this closes and is not something a script
 * that only starts running after that gap could ever observe.
 */
export function assignWindowsChildMemoryLimit(pid: number, limitBytes: number): Promise<boolean> {
  const script = `
$initialProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($initialProcess -eq $null) { exit }
$initialStartTime = $initialProcess.StartTime
${WINDOWS_JOB_MEMORY_LIMIT_POWERSHELL_SOURCE}
$confirmProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($confirmProcess -eq $null -or $confirmProcess.StartTime -ne $initialStartTime) { exit }
$handle = [JobMemoryLimit.Native]::OpenProcess(${WINDOWS_JOB_OBJECT_PROCESS_ACCESS}, $false, ${pid})
if (Set-JobMemoryLimit -bytes ${limitBytes} -processHandle $handle) {
  [Console]::Out.Write("${WINDOWS_JOB_MEMORY_LIMIT_SUCCESS_MARKER}")
}
`;
  return new Promise((resolve) => {
    execFile("powershell.exe", [
      "-NonInteractive", "-NoProfile", "-Command", script
    ], { timeout: WINDOWS_JOB_ASSIGN_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
    (error, stdout) => {
      resolve(error === null && stdout === WINDOWS_JOB_MEMORY_LIMIT_SUCCESS_MARKER);
    });
  });
}
