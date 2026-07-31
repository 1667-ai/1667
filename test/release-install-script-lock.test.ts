/**
 * Cross-protocol Install Root lock: shell lockf/flock and runtime flock(2).
 * Shell holders block with builtin read on stdin so children never inherit FD 9.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderInstallScriptsForVersion } from "../scripts/release-install-script.js";
import { SHELL_INSTALLER_LOCK } from "../scripts/release-install-script-lock-lib.js";
import {
  INSTALL_REPO,
  INSTALL_VERSION,
  digestsFor,
  execFileAsync,
  hostShellInstallerTarget
} from "./release-install-script-fixture.js";
import { acquireInstallationLock } from "../tui/src/install-lock.js";

async function makeRoot(label: string): Promise<string> {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  return mkdtemp(path.join(homeScratch, label));
}

function platformLockSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux";
}

/** Minimal shell that uses the same acquire_lock/release_lock as the installer. */
function shellLockHarness(body: string): string {
  return `#!/bin/sh
set -eu
LOCK_FILE='.1667-install.lock'
die() {
  printf '1667 install: %s\\n' "\$*" >&2
  exit 1
}
${SHELL_INSTALLER_LOCK}
${body}
`;
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

/** Match die() text in execFile error message and/or stderr. */
function rejectsWithMessage(
  promise: Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  return assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const extra = error as Error & { stderr?: string | Buffer };
    const stderr = typeof extra.stderr === "string"
      ? extra.stderr
      : Buffer.isBuffer(extra.stderr)
        ? extra.stderr.toString("utf8")
        : "";
    return pattern.test(`${error.message}\n${stderr}`);
  });
}

test("runtime-held lock blocks shell; succeeds after runtime release", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  const root = await makeRoot("install-lock-rt-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);

  const lock = await acquireInstallationLock(prefix);
  t.after(async () => {
    try {
      await lock.release();
    } catch {
      // Released in test body.
    }
  });

  const harness = shellLockHarness(`
acquire_lock "$1"
printf 'shell-acquired\\n'
release_lock "$1"
`);
  const harnessPath = path.join(root, "hold.sh");
  await writeFile(harnessPath, harness, { mode: 0o755 });

  await rejectsWithMessage(
    execFileAsync("sh", [harnessPath, prefix], { cwd: root }),
    /holds the Install Root lock/i
  );

  await lock.release();
  const { stdout } = await execFileAsync("sh", [harnessPath, prefix], { cwd: root });
  assert.match(stdout, /shell-acquired/);
});

test("shell-held lock blocks runtime; succeeds after shell release via stdin", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  const root = await makeRoot("install-lock-sh-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const ready = path.join(root, "ready");

  // Builtin read holds without spawning children that inherit FD 9.
  const harness = shellLockHarness(`
acquire_lock "$1"
printf 'ready\\n' > "$2"
read -r _gate || true
release_lock "$1"
`);
  const harnessPath = path.join(root, "holder.sh");
  await writeFile(harnessPath, harness, { mode: 0o755 });
  const holder = spawn("sh", [harnessPath, prefix, ready], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => killQuiet(holder));
  await waitForFile(ready);

  await assert.rejects(
    acquireInstallationLock(prefix),
    /holds the Install Root lock/i
  );

  holder.stdin!.write("release\n");
  holder.stdin!.end();
  const exitCode = await new Promise<number>((resolve) => {
    holder.once("close", (code) => resolve(code ?? 1));
  });
  assert.equal(exitCode, 0);

  const lock = await acquireInstallationLock(prefix);
  await lock.release();
});

test("SIGKILL of shell holder releases lock for runtime", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  const root = await makeRoot("install-lock-kill-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const ready = path.join(root, "ready");

  // Block on builtin read (no sleep child inheriting FD 9).
  const harness = shellLockHarness(`
acquire_lock "$1"
printf 'ready\\n' > "$2"
read -r _gate || true
release_lock "$1"
`);
  const harnessPath = path.join(root, "holder.sh");
  await writeFile(harnessPath, harness, { mode: 0o755 });
  const holder = spawn("sh", [harnessPath, prefix, ready], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => killQuiet(holder));
  await waitForFile(ready);

  await assert.rejects(
    acquireInstallationLock(prefix),
    /holds the Install Root lock/i
  );

  await new Promise<void>((resolve) => {
    if (holder.exitCode !== null || holder.signalCode !== null) {
      resolve();
      return;
    }
    holder.once("close", () => resolve());
    killQuiet(holder, "SIGKILL");
  });

  const lock = await acquireInstallationLock(prefix);
  await lock.release();
});

test("symlink lock path is rejected and left intact", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  const root = await makeRoot("install-lock-symlink-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const target = path.join(root, "lock-target");
  await writeFile(target, "", { mode: 0o600 });
  const lockLink = path.join(prefix, ".1667-install.lock");
  await symlink(target, lockLink);

  const harness = shellLockHarness(`
acquire_lock "$1"
printf 'should-not-acquire\\n'
release_lock "$1"
`);
  const harnessPath = path.join(root, "try.sh");
  await writeFile(harnessPath, harness, { mode: 0o755 });

  await rejectsWithMessage(
    execFileAsync("sh", [harnessPath, prefix], { cwd: root }),
    /lock path is a symbolic link/i
  );
  const st = await lstat(lockLink);
  assert.equal(st.isSymbolicLink(), true);
});

test("directory at lock path is rejected as nonregular", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  const root = await makeRoot("install-lock-dir-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const lockDir = path.join(prefix, ".1667-install.lock");
  await mkdir(lockDir, { mode: 0o700 });

  const harness = shellLockHarness(`
acquire_lock "$1"
printf 'should-not-acquire\\n'
release_lock "$1"
`);
  const harnessPath = path.join(root, "try.sh");
  await writeFile(harnessPath, harness, { mode: 0o755 });

  await rejectsWithMessage(
    execFileAsync("sh", [harnessPath, prefix], { cwd: root }),
    /lock path is not a regular file/i
  );
  const st = await stat(lockDir);
  assert.equal(st.isDirectory(), true);
});

test("cleanup removes staging under lock before release so successor staging survives", async (t) => {
  const root = await makeRoot("install-cleanup-race-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const body = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests: Object.fromEntries(digestsFor(INSTALL_VERSION).map((a) => [a.fileName, a.sha256]))
  })["install-beta.sh"]!;
  const cleanup = body.match(/cleanup_install\(\) \{[\s\S]*?\n\}/);
  assert.ok(cleanup !== null, "cleanup_install present");
  const block = cleanup[0]!;
  const rmAt = block.indexOf("rm -f");
  const releaseAt = block.indexOf("release_lock");
  assert.ok(rmAt >= 0 && releaseAt > rmAt, "staging removed before release_lock");
  // Generated download closes lock FD in the background child.
  assert.match(body, /curl[\s\S]*9>&-/);
  // Bounded decompress and extraction children also close FD 9.
  assert.match(body, /gzip -dc "\$archive_path" 9>&-/);
  assert.match(body, /tar --no-same-owner -xf "\$tar_path" -C "\$stage" "\$member" 9>&-/);
  // Post-lock command-substitution / parenthesized subshells close FD 9 themselves.
  assert.match(body, /actual=\$\(\s*exec 9>&-\s*file_sha256/);
  assert.match(body, /size=\$\(\s*exec 9>&-/);
  assert.match(body, /phase=\$\(\s*exec 9>&-/);
  assert.match(body, /installation_id=\$\(\s*exec 9>&-/);
  assert.match(body, /out_text=\$\(\s*exec 9>&-/);
  assert.match(body, /product=\$\(\s*exec 9>&-/);
  assert.match(body, /version=\$\(\s*exec 9>&-/);
  assert.match(body, /art=\$\(\s*exec 9>&-/);
  assert.match(body, /kind=\$\(\s*exec 9>&-/);
  assert.match(body, /case "\$\(\s*exec 9>&-/);
  assert.match(body, /\(\s*exec 9>&-\s*set -C/);
  assert.match(body, /parsed=\$\(\s*exec 9>&-/);
  // Staging cleanup is gated on CLEANUP_OWNS_STAGING.
  assert.match(body, /CLEANUP_OWNS_STAGING=0/);
  assert.match(body, /\[ "\$\{CLEANUP_OWNS_STAGING:-0\}" -eq 1 \]/);
});

test("generated installer refuses nonregular lock path", async (t) => {
  const hostTarget = hostShellInstallerTarget();
  if (hostTarget === null) {
    t.skip("Host cannot run the POSIX Shell Installer");
    return;
  }
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  const root = await makeRoot("install-lock-gen-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests: Object.fromEntries(digestsFor(INSTALL_VERSION).map((a) => [a.fileName, a.sha256])),
    assetBaseUrl: "http://127.0.0.1:9"
  })["install-beta.sh"]!;
  const scriptPath = path.join(root, "install-beta.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });

  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const lockDir = path.join(prefix, ".1667-install.lock");
  await mkdir(lockDir, { mode: 0o700 });

  await rejectsWithMessage(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], { cwd: root }),
    /lock path is not a regular file/i
  );
  const st = await stat(lockDir);
  assert.equal(st.isDirectory(), true);
  await assert.rejects(access(path.join(prefix, "1667")));
});

test("lock file persists after release (never unlinked)", async (t) => {
  if (!platformLockSupported()) {
    t.skip("Install Root lock tools are Darwin/Linux only");
    return;
  }
  const root = await makeRoot("install-lock-persist-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const lockFilePath = path.join(prefix, ".1667-install.lock");

  const lock = await acquireInstallationLock(prefix);
  await lock.release();
  await access(lockFilePath);
  const st = await stat(lockFilePath);
  assert.equal(st.isFile(), true);

  const harness = shellLockHarness(`
acquire_lock "$1"
release_lock "$1"
`);
  await writeFile(path.join(root, "once.sh"), harness, { mode: 0o755 });
  await execFileAsync("sh", [path.join(root, "once.sh"), prefix], { cwd: root });
  await access(lockFilePath);
  assert.equal((await stat(lockFilePath)).isFile(), true);
  await writeFile(lockFilePath, "marker\n", { mode: 0o600 });
  await execFileAsync("sh", [path.join(root, "once.sh"), prefix], { cwd: root });
  assert.equal(await readFile(lockFilePath, "utf8"), "marker\n");
});
