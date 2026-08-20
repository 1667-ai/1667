/**
 * Recovery probe signal behavior: INT/TERM traps must see PROBE_PID when
 * recover_install runs in the lock-owning shell (not under command substitution).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { releaseArchiveFileName } from "../scripts/release-archive.js";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import {
  INSTALL_PREVIOUS_FILE,
  INSTALL_TRANSACTION_FILE
} from "../shared/install-layout.js";
import { INSTALL_OWNERSHIP_FILE } from "../shared/install-ownership-record.js";
import { acquireInstallationLock } from "../tui/src/install-lock.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  canonicalTxnBytes,
  hostShellInstallerTarget,
  writePublishedArchives
} from "./release-install-script-fixture.js";

test("SIGTERM during recovery probe exits 143, kills probe, keeps txn, no ownership", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-recover-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostShellInstallerTarget();
  if (hostTarget === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }

  const digests = await writePublishedArchives(path.join(root, "archives"), INSTALL_VERSION);
  const hostArchive = releaseArchiveFileName(INSTALL_VERSION, hostTarget);
  const hostDigest = digests[hostArchive];
  if (hostDigest === undefined) throw new Error("host archive digest missing");

  // Hang forever after publishing PID; ignore TERM/INT so only stop_probe SIGKILL reaps.
  // exec replaces the shell so the recorded PID is the sleeper (no orphaned sleep child).
  const probePidPath = path.join(root, "probe.pid");
  const hangStub = `#!/bin/sh
printf '%s\\n' "$$" > '${probePidPath.replace(/'/g, `'\\''`)}'
trap '' TERM INT
exec sleep 3600
`;

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    // Recovery must not download; a non-listening base proves that path is unused.
    assetBaseUrl: "http://127.0.0.1:1"
  })["install-beta.sh"]!;
  // Recovery must set RECOVER_STATUS in-process (no command substitution around recover).
  assert.match(scriptBody, /RECOVER_STATUS=/);
  assert.match(scriptBody, /recover_install "\$prefix"/);
  assert.doesNotMatch(scriptBody, /recover_status=\$\(recover_install/);
  assert.doesNotMatch(scriptBody, /\$\(recover_install/);
  assert.match(scriptBody, /RECOVER_STATUS=completed/);
  assert.match(scriptBody, /stop_probe/);

  const scriptPath = path.join(root, "install-recover-signal.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const installRoot = await realpath(prefix);
  await writeFile(path.join(prefix, "1667"), hangStub, { mode: 0o755 });
  const txnBytes = canonicalTxnBytes({
    phase: "activated",
    version: INSTALL_VERSION,
    channel: "beta",
    target: hostTarget,
    digest: hostDigest,
    root: installRoot
  });
  await writeFile(path.join(prefix, INSTALL_TRANSACTION_FILE), txnBytes, { mode: 0o600 });

  const child = spawn("sh", [scriptPath, "--prefix", prefix], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.resume();
  child.stderr?.resume();

  let childExited = false;
  let recordedProbePid: number | undefined;
  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      childExited = true;
      resolve(code);
    });
  });
  t.after(() => {
    // Reap probe if assertions fail before stop_probe / normal signal cleanup.
    if (recordedProbePid !== undefined) {
      try {
        process.kill(recordedProbePid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    if (!childExited && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  // Wait until the recovery probe child is running (active executable started).
  const probeStarted = await waitForProbePid(probePidPath, exitPromise, 8_000);
  if (typeof probeStarted === "object" && "exited" in probeStarted) {
    throw new Error(`installer exited ${probeStarted.exited} before recovery probe started`);
  }
  if (probeStarted === "timeout") {
    throw new Error("recovery probe never started before timeout");
  }
  const probePid = probeStarted;
  recordedProbePid = probePid;
  assert.ok(Number.isInteger(probePid) && probePid > 0, `invalid probe pid: ${probePid}`);
  assert.equal(processAlive(probePid), true, "probe must be alive before SIGTERM");

  // Signal only the installer parent; probe must die via stop_probe in the trap.
  assert.ok(child.pid !== undefined, "installer parent pid missing");
  process.kill(child.pid, "SIGTERM");

  const killTimer = setTimeout(() => {
    if (child.pid !== undefined && !childExited) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  }, 5_000);
  let exitCode: number | null;
  try {
    exitCode = await exitPromise;
  } finally {
    clearTimeout(killTimer);
  }
  assert.equal(exitCode, 143, "installer parent must exit 128+TERM");

  // Probe child must be reaped (not left orphaned ignoring TERM).
  assert.equal(processAlive(probePid), false, "recovery probe child must be dead");

  // Transaction preserved for retry; Ownership must not publish mid-probe.
  assert.equal(
    await readFile(path.join(prefix, INSTALL_TRANSACTION_FILE), "utf8"),
    txnBytes
  );
  await assert.rejects(access(path.join(prefix, INSTALL_OWNERSHIP_FILE)));
  await assert.rejects(access(path.join(prefix, INSTALL_PREVIOUS_FILE)));
  // Active hang stub remains for a later recovery attempt.
  await access(path.join(prefix, "1667"));

  // Install Root lock must be immediately re-acquirable.
  const lockPath = path.join(prefix, ".1667-install.lock");
  const lockStat = await stat(lockPath);
  assert.equal(lockStat.isFile(), true);
  const lock = await acquireInstallationLock(prefix);
  await lock.release();
});

test("SIGTERM and SIGINT during managed active probe exit cleanly", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-managed-probe-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostShellInstallerTarget();
  if (hostTarget === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const digests = await writePublishedArchives(path.join(root, "archives"), INSTALL_VERSION);
  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: "http://127.0.0.1:1"
  })["install-beta.sh"]!;
  const scriptPath = path.join(root, "install-managed-signal.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  const signals: readonly [NodeJS.Signals, number][] = [
    ["SIGTERM", 143],
    ["SIGINT", 130]
  ];
  for (const [signal, expectedExit] of signals) {
    const prefix = path.join(root, signal.toLowerCase());
    await mkdir(prefix, { mode: 0o755 });
    await chmod(prefix, 0o755);
    const probePidPath = path.join(root, signal.toLowerCase() + ".probe.pid");
    const hangStub = `#!/bin/sh
printf '%s\\n' "$$" > '${probePidPath.replace(/'/g, `'\\''`)}'
trap '' TERM INT
exec sleep 3600
`;
    const id = "0123456789abcdef0123456789abcdef";
    const ownership: string = JSON.stringify({
      schemaVersion: 1,
      product: "1667",
      installationId: id,
      method: "shell",
      channel: "beta",
      installRoot: prefix,
      executable: prefix + "/1667",
      artifactTarget: hostTarget
    }) + "\n";
    await writeFile(path.join(prefix, "1667"), hangStub, { mode: 0o755 });
    await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), ownership, { mode: 0o600 });

    const child = spawn("sh", [scriptPath, "--prefix", prefix], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.resume();
    child.stderr?.resume();
    let childExited = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => {
        childExited = true;
        resolve(code);
      });
    });
    let probePid: number | undefined;
    try {
      const probeStarted = await waitForProbePid(probePidPath, exitPromise, 8_000);
      if (typeof probeStarted !== "number") {
        throw new Error("managed active probe did not start before installer exit or timeout");
      }
      probePid = probeStarted;
      assert.equal(processAlive(probePid), true, "managed probe must be alive before signal");
      assert.ok(child.pid !== undefined, "installer parent pid missing");
      process.kill(child.pid, signal);

      const killTimer = setTimeout(() => {
        if (child.pid !== undefined && !childExited) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // Gone.
          }
        }
      }, 5_000);
      let exitCode: number | null;
      try {
        exitCode = await exitPromise;
      } finally {
        clearTimeout(killTimer);
      }
      assert.equal(exitCode, expectedExit);
      assert.equal(processAlive(probePid), false, "managed probe must be reaped");
      assert.equal(await readFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), "utf8"), ownership);
      await access(path.join(prefix, "1667"));
      await assert.rejects(access(path.join(prefix, INSTALL_TRANSACTION_FILE)));
      const lock = await acquireInstallationLock(prefix);
      await lock.release();
    } finally {
      if (probePid !== undefined && processAlive(probePid)) {
        try {
          process.kill(probePid, "SIGKILL");
        } catch {
          // Gone.
        }
      }
      if (!childExited && child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Gone.
        }
      }
    }
  }
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProbePid(
  probePidPath: string,
  exitPromise: Promise<number | null>,
  timeoutMs: number
): Promise<number | "timeout" | { exited: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null | undefined;
  void exitPromise.then((code) => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      return { exited: exitCode };
    }
    try {
      const text = (await readFile(probePidPath, "utf8")).trim();
      const pid = Number(text);
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
        return pid;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (exitCode !== undefined) {
    return { exited: exitCode };
  }
  return "timeout";
}
