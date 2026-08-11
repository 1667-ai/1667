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
  WINDOWS_JOB_OBJECT_PROCESS_ACCESS
} from "../shared/windows-job-memory-limit.js";
import { ServiceError } from "./errors.js";

export const RSS_POLL_INTERVAL_MS = 200;
const WINDOWS_JOB_ASSIGN_TIMEOUT_MS = 3_000;

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
 * range, pointer-compression cage) far past 512 MiB before any image code
 * runs; and a Linux cgroup v2 `memory.max` limit needs a cgroup subtree this
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
 * Windows Job Object with a committed-memory ceiling. This is the same
 * kernel primitive `tui/src/clipboard-windows.ts` uses for its own helper,
 * shared through `shared/windows-job-memory-limit.ts`; the only difference
 * is which process the job targets, the current process there against a
 * separate, named process here. Once assigned, Windows itself refuses any
 * allocation that would push the child's committed memory past
 * `limitBytes`. That is a genuine kernel-enforced ceiling, not a poll: no
 * `pollChildMemory` call is ever armed for Windows (see the `rssTimer` in
 * `launchImageNormalizeChild`, gated to `posix`).
 *
 * Best effort, the same tolerance the clipboard helper already has for a
 * `powershell.exe` that cannot be reached: if the assignment fails for any
 * reason, this never rejects, and the child keeps running unbounded by this
 * mechanism. The header parser's pixel and byte limits
 * (`server/image-header.ts`) remain the control in that case, the same as
 * they are on every platform regardless of this bound.
 *
 * There is a short window between the child's own process start and a
 * successful assignment; the caller closes most of it by holding the
 * child's stdin, and therefore its Source Image bytes, until this settles
 * (see `sendChildInput` in `launchImageNormalizeChild`).
 */
export function assignWindowsChildMemoryLimit(pid: number, limitBytes: number): Promise<void> {
  const script = `${WINDOWS_JOB_MEMORY_LIMIT_POWERSHELL_SOURCE}
$handle = [JobMemoryLimit.Native]::OpenProcess(${WINDOWS_JOB_OBJECT_PROCESS_ACCESS}, $false, ${pid})
Set-JobMemoryLimit -bytes ${limitBytes} -processHandle $handle
`;
  return new Promise((resolve) => {
    execFile("powershell.exe", [
      "-NonInteractive", "-NoProfile", "-Command", script
    ], { timeout: WINDOWS_JOB_ASSIGN_TIMEOUT_MS, windowsHide: true }, () => resolve());
  });
}
