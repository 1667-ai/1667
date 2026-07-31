/**
 * Process liveness for tests that prove a process group was killed.
 *
 * kill(2) still finds a process that stopped but that its parent did not reap.
 * When a test kills a whole process group, the parent of a descendant dies with
 * it, so the descendant becomes a zombie and the init process reaps it later.
 * That delay is not under the control of the code being tested, so a test that
 * uses kill(2) alone reports a killed descendant as alive.
 *
 * A zombie holds no pipe and runs no code. These helpers read the process state
 * and count a zombie as stopped, so a test can prove termination without a
 * wait loop.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/** True while the process runs. A zombie is stopped, not running. */
export function processIsRunning(pid: number): boolean {
  const state = spawnSync("ps", ["-o", "state=", "-p", String(pid)], {
    encoding: "utf8"
  });
  if (state.error !== undefined || state.status === null) {
    // Windows has no ps, and a killed ps gives no state. Use the coarser
    // kill(2) probe, which cannot see a zombie.
    return processExists(pid);
  }
  if (state.status !== 0) return false;
  const code = state.stdout.trim();
  return code.length > 0 && !code.startsWith("Z");
}

/**
 * Fails when the process still runs. A reaped or zombie process passes.
 * Use this only for a process whose parent died with it. For a direct child of
 * this process, use assertProcessIsReaped: this process is the parent, so it
 * must reap the child, and the weaker check would hide a missing reap.
 */
export function assertProcessIsNotRunning(pid: number, label: string): void {
  assert.equal(
    processIsRunning(pid),
    false,
    `${label} pid ${pid} still runs`
  );
}

/**
 * Fails unless the process is gone. Node reaps a direct child, so a test that
 * waits for a direct child can require the reap and not only the kill.
 */
export function assertProcessIsReaped(pid: number, label: string): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: NodeJS.ErrnoException) => error.code === "ESRCH",
    `${label} pid ${pid} was not reaped`
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}
