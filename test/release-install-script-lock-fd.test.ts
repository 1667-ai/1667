import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import {
  createInstallOwnershipRecord,
  INSTALL_OWNERSHIP_FILE,
  serializeInstallOwnershipRecord
} from "../shared/install-ownership-record.js";
import { acquireInstallationLock } from "../tui/src/install-lock.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  hostShellInstallerTarget,
  releaseStub,
  writePublishedArchives
} from "./release-install-script-fixture.js";

test("managed ownership comparison helper cannot retain the Install Root lock", async (t) => {
  const target = hostShellInstallerTarget();
  if (target === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  const parent = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(parent, { recursive: true, mode: 0o755 });
  await chmod(parent, 0o755);
  const root = await mkdtemp(path.join(parent, "install-lock-fd-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const prefix = path.join(root, "prefix");
  const tools = path.join(root, "tools");
  const cmpPidPath = path.join(root, "cmp.pid");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  await mkdir(tools, { mode: 0o755 });
  const escapedCmpPidPath = cmpPidPath.replace(/'/g, "'\\''");
  const stalledCmp = "#!/bin/sh\n"
    + "printf '%s\\n' \"$$\" > '" + escapedCmpPidPath + "'\n"
    + "trap '' TERM INT\n"
    + "exec sleep 3600\n";
  await writeFile(path.join(tools, "cmp"), stalledCmp, { mode: 0o755 });

  const executable = path.join(prefix, "1667");
  const ownership = serializeInstallOwnershipRecord(createInstallOwnershipRecord({
    installationId: "0123456789abcdef0123456789abcdef",
    channel: "beta",
    installRoot: prefix,
    executable,
    artifactTarget: target
  }));
  await writeFile(executable, releaseStub(INSTALL_VERSION, target), { mode: 0o755 });
  await writeFile(path.join(prefix, INSTALL_OWNERSHIP_FILE), ownership, { mode: 0o600 });

  const scriptPath = path.join(root, "install-beta.sh");
  const digests = await writePublishedArchives(path.join(root, "archives"), INSTALL_VERSION);
  await writeFile(scriptPath, renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: "http://127.0.0.1:1"
  })["install-beta.sh"]!, { mode: 0o755 });

  const child = spawn("sh", [scriptPath, "--prefix", prefix], {
    cwd: root,
    env: {
      ...process.env,
      PATH: tools + path.delimiter + (process.env["PATH"] ?? "/usr/bin:/bin")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.resume();
  child.stderr?.resume();
  let childExited = false;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on("exit", (code, signal) => {
      childExited = true;
      resolve({ code, signal });
    })
  );
  let cmpPid: number | undefined;
  t.after(() => {
    if (cmpPid !== undefined && processAlive(cmpPid)) {
      try {
        process.kill(cmpPid, "SIGKILL");
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

  cmpPid = await waitForPid(cmpPidPath);
  assert.equal(processAlive(cmpPid), true, "comparison helper must be stalled");
  assert.ok(child.pid !== undefined, "installer parent pid missing");
  process.kill(child.pid, "SIGKILL");
  const exit = await exitPromise;
  assert.equal(exit.signal, "SIGKILL");
  assert.equal(processAlive(cmpPid), true, "stalled helper must survive parent death");

  const lock = await acquireInstallationLock(prefix);
  await lock.release();
});

async function waitForPid(filePath: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(filePath, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) return pid;
    } catch {
      // Helper has not started yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await access(filePath);
  throw new Error("comparison helper did not start");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
