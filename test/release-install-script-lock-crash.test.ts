/**
 * Parent-crash Install Root lock: killed installer releases lock while extract,
 * decompress, or checksum wrappers that closed FD 9 still run.
 *
 * After SIGKILL of the top installer, wait for ChildProcess `exit` (not `close`).
 * A deliberately surviving command-substitution subshell can keep a stdio pipe
 * open even after it closed lock FD 9; `close` would hang on that pipe.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  hostPublishedTarget,
  writePublishedArchives
} from "./release-install-script-fixture.js";
import { acquireInstallationLock } from "../tui/src/install-lock.js";

type HangMode = "extract" | "decompress" | "checksum" | "size";

async function makeRoot(label: string): Promise<string> {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  return mkdtemp(path.join(homeScratch, label));
}

function platformLockSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

function killQuiet(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    child.kill(signal);
  } catch {
    // Gone.
  }
}

function killPidQuiet(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Gone.
  }
}

/** Record PID, ignore HUP, detach stdio, exec sleep (recorded PID is sleeper). */
function hangBody(pidFile: string): string {
  return [
    `  printf '%s\\n' "$$" > ${JSON.stringify(pidFile)}`,
    "  trap '' HUP",
    "  exec >/dev/null 2>&1 </dev/null",
    "  exec sleep 3600"
  ].join("\n");
}

/** PATH tar wrapper: hang on extract (-x). */
function hangingTarWrapperScript(pidFile: string): string {
  const body = hangBody(pidFile);
  return [
    "#!/bin/sh",
    "extract=0",
    'for arg in "$@"; do',
    '  case "$arg" in',
    "    --*) ;;",
    "    -*x*) extract=1 ;;",
    "  esac",
    "done",
    'if [ "$extract" -eq 1 ]; then',
    body,
    "fi",
    'exec /usr/bin/tar "$@"'
  ].join("\n") + "\n";
}

/** PATH gzip wrapper: hang on decompress (-dc) used before ustar validation. */
function hangingGzipWrapperScript(pidFile: string): string {
  return ["#!/bin/sh", hangBody(pidFile)].join("\n") + "\n";
}

/** PATH checksum helper: always hang (installer blocks after download). */
function hangingChecksumWrapperScript(pidFile: string): string {
  return ["#!/bin/sh", hangBody(pidFile)].join("\n") + "\n";
}

/** PATH wc helper: hang on archive size check after download. */
function hangingWcWrapperScript(pidFile: string): string {
  return ["#!/bin/sh", hangBody(pidFile)].join("\n") + "\n";
}

interface CrashScenario {
  readonly root: string;
  readonly prefix: string;
  readonly wrapperPid: number;
  readonly installer: ChildProcess;
  readonly installerExit: Promise<number | null>;
  /** Kill wrapper + installer tree and stop the asset server. Always safe. */
  cleanup(): Promise<void>;
}

/**
 * Spawn generated install-beta.sh against a hanging PATH helper.
 * Registers t.after cleanup so assertion failures still reap every child.
 */
async function startHangScenario(
  t: { after: (fn: () => void | Promise<void>) => void },
  input: {
    readonly label: string;
    readonly mode: HangMode;
    readonly pidFileName: string;
  }
): Promise<CrashScenario> {
  const root = await makeRoot(input.label);
  t.after(() => rm(root, { recursive: true, force: true }));

  const archivesDir = path.join(root, "archives");
  const digests = await writePublishedArchives(archivesDir, INSTALL_VERSION);
  const openResponses: ServerResponse[] = [];
  const server: Server = createServer((request, response) => {
    openResponses.push(response);
    const name = path.basename(request.url ?? "");
    const file = path.join(archivesDir, name);
    void readFile(file).then((bytes) => {
      response.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": bytes.byteLength
      });
      response.end(bytes);
    }, () => {
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  let serverClosed = false;
  const closeServer = async (): Promise<void> => {
    if (serverClosed) return;
    serverClosed = true;
    for (const response of openResponses) {
      try {
        response.destroy();
      } catch {
        // Already closed.
      }
    }
    openResponses.length = 0;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer();
    throw new Error("server address missing");
  }
  const base = `http://127.0.0.1:${address.port}`;

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  // Static: post-lock helpers close FD 9 so a surviving child cannot pin the lock.
  assert.match(scriptBody, /gzip -dc "\$archive_path" 9>&-/);
  assert.match(scriptBody, /parsed=\$\(\s*exec 9>&-/);
  assert.match(
    scriptBody,
    /tar --no-same-owner -xf "\$tar_path" -C "\$stage" "\$member" 9>&-/
  );
  assert.match(scriptBody, /actual=\$\(\s*exec 9>&-\s*file_sha256/);
  assert.match(scriptBody, /size=\$\(\s*exec 9>&-/);
  assert.match(scriptBody, /phase=\$\(\s*exec 9>&-/);
  assert.match(scriptBody, /installation_id=\$\(\s*exec 9>&-/);
  assert.match(scriptBody, /out_text=\$\(\s*exec 9>&-/);
  assert.match(scriptBody, /case "\$\(\s*exec 9>&-/);
  assert.match(scriptBody, /\(\s*exec 9>&-\s*set -C/);

  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  const pidFile = path.join(root, input.pidFileName);
  const bin = path.join(root, "bin");
  await mkdir(bin, { mode: 0o755 });
  if (input.mode === "checksum") {
    const checksum = hangingChecksumWrapperScript(pidFile);
    await writeFile(path.join(bin, "shasum"), checksum, { mode: 0o755 });
    await writeFile(path.join(bin, "sha256sum"), checksum, { mode: 0o755 });
  } else if (input.mode === "size") {
    await writeFile(path.join(bin, "wc"), hangingWcWrapperScript(pidFile), {
      mode: 0o755
    });
  } else if (input.mode === "decompress") {
    await writeFile(path.join(bin, "gzip"), hangingGzipWrapperScript(pidFile), {
      mode: 0o755
    });
  } else {
    await writeFile(path.join(bin, "tar"), hangingTarWrapperScript(pidFile), {
      mode: 0o755
    });
  }

  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);

  const installer = spawn("sh", [scriptPath, "--prefix", prefix], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  installer.stdout?.resume();
  installer.stderr?.resume();

  let installerExited = false;
  const installerExit = new Promise<number | null>((resolve) => {
    installer.on("exit", (code) => {
      installerExited = true;
      resolve(code);
    });
  });

  let wrapperPid: number | null = null;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    // Wrapper first (may still hold inherited stdio after parent death), then
    // installer. t.after + explicit cleanup both call this; idempotent.
    if (wrapperPid !== null) {
      killPidQuiet(wrapperPid, "SIGKILL");
    }
    if (!installerExited && installer.pid !== undefined) {
      killPidQuiet(installer.pid, "SIGKILL");
    }
    killQuiet(installer, "SIGKILL");
    await closeServer();
  };
  t.after(() => cleanup());

  try {
    await waitForFile(pidFile, 15_000);
    wrapperPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(
      Number.isInteger(wrapperPid) && wrapperPid > 0,
      `${input.mode} wrapper pid recorded`
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    root,
    prefix,
    wrapperPid,
    installer,
    installerExit,
    cleanup
  };
}

/** SIGKILL top installer; wait for process exit (not stdio close). */
async function killInstallerWaitExit(scenario: CrashScenario): Promise<void> {
  const { installer, installerExit } = scenario;
  if (installer.exitCode === null && installer.signalCode === null) {
    // Prefer `exit` over `close`: surviving listing `$()` subshells can retain
    // Node's pipe ends after correctly closing lock FD 9.
    await new Promise<void>((resolve) => {
      if (installer.exitCode !== null || installer.signalCode !== null) {
        resolve();
        return;
      }
      installer.once("exit", () => resolve());
      killQuiet(installer, "SIGKILL");
    });
  }
  await installerExit;
}

function assertProcessAlive(pid: number, label: string): void {
  try {
    process.kill(pid, 0);
  } catch {
    assert.fail(`${label} must survive installer parent death`);
  }
}

async function assertLockHeldThenFreeAfterKill(
  scenario: CrashScenario,
  wrapperLabel: string
): Promise<void> {
  await assert.rejects(
    acquireInstallationLock(scenario.prefix),
    /holds the Install Root lock/i
  );
  await killInstallerWaitExit(scenario);
  assertProcessAlive(scenario.wrapperPid, wrapperLabel);
  const lock = await acquireInstallationLock(scenario.prefix);
  await lock.release();
  await scenario.cleanup();
}

test("killed generated-installer parent releases lock while extract wrapper survives", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  if (hostPublishedTarget() === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const scenario = await startHangScenario(t, {
    label: "install-lock-extract-",
    mode: "extract",
    pidFileName: "extract.pid"
  });
  await assertLockHeldThenFreeAfterKill(scenario, "extract wrapper");
});

test("killed generated-installer parent releases lock while decompress wrapper survives", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  if (hostPublishedTarget() === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const scenario = await startHangScenario(t, {
    label: "install-lock-decompress-",
    mode: "decompress",
    pidFileName: "decompress.pid"
  });
  await assertLockHeldThenFreeAfterKill(scenario, "decompress wrapper");
});

test("killed generated-installer parent releases lock while checksum wrapper survives", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  if (hostPublishedTarget() === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const scenario = await startHangScenario(t, {
    label: "install-lock-checksum-",
    mode: "checksum",
    pidFileName: "checksum.pid"
  });
  // Installer holds lock while blocked on hanging digest helper after download.
  // verify_sha256 closes FD 9 inside the actual=$(...) subshell itself.
  await assertLockHeldThenFreeAfterKill(scenario, "checksum wrapper");
});

test("killed generated-installer parent releases lock while archive-size wc wrapper survives", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  if (hostPublishedTarget() === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const scenario = await startHangScenario(t, {
    label: "install-lock-size-",
    mode: "size",
    pidFileName: "size.pid"
  });
  // download_archive closes FD 9 inside the size=$(...) subshell itself.
  await assertLockHeldThenFreeAfterKill(scenario, "archive-size wc wrapper");
});
