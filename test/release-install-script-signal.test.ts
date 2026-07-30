import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
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

test("generated installer INT during download exits 130 without ownership", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const archivesDir = path.join(root, "archives");
  const digests = await writePublishedArchives(archivesDir, INSTALL_VERSION);
  // Track open sockets so close is deterministic even when curl is mid-transfer.
  // First request proves background curl is running and the shell is in wait.
  const openResponses: ServerResponse[] = [];
  let resolveDownloadStarted: (() => void) | null = null;
  const downloadStarted = new Promise<void>((resolve) => {
    resolveDownloadStarted = resolve;
  });
  const server = createServer((_request, response) => {
    openResponses.push(response);
    // Stall the body so the installer holds the lock during download.
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": "1048576"
    });
    if (resolveDownloadStarted !== null) {
      const done = resolveDownloadStarted;
      resolveDownloadStarted = null;
      done();
    }
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
  t.after(async () => {
    await closeServer();
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  const base = `http://127.0.0.1:${address.port}`;

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  assert.match(scriptBody, /on_install_signal INT/);
  assert.match(scriptBody, /exit 130/);
  assert.match(scriptBody, /exit 143/);
  // Traps are installed only after a successful lock acquisition.
  assert.match(
    scriptBody,
    /acquire_lock "\$prefix"\s*\n\s*# EXIT cleans once[\s\S]*?trap 'on_install_signal INT/
  );
  // Download must be wait-interruptible so traps run during transfer.
  assert.match(scriptBody, /DOWNLOAD_PID=\$!/);
  assert.match(scriptBody, /stop_download/);

  const scriptPath = path.join(root, "install-signal.sh");
  await writeFile(scriptPath, scriptBody, { mode: 0o755 });
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const lockPath = path.join(prefix, ".1667-install.lock");

  const child = spawn("sh", [scriptPath, "--prefix", prefix], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  // Drain pipes so a full buffer cannot stall the child.
  child.stdout?.resume();
  child.stderr?.resume();

  let childExited = false;
  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      childExited = true;
      resolve(code);
    });
  });
  t.after(() => {
    if (!childExited && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      // Also kill process group members (background curl) if still around.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Not a process-group leader or already gone.
      }
    }
  });

  // Synchronize on curl reaching the fixture, not lock-file creation.
  // The lock file appears at open/lockf, before traps and before wait on curl.
  let startDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = new Promise<"timeout">((resolve) => {
    startDeadlineTimer = setTimeout(() => resolve("timeout"), 5_000);
  });
  const startOutcome = await Promise.race([
    downloadStarted.then(() => "started" as const),
    startDeadline,
    exitPromise.then((code) => ({ exited: code }))
  ]);
  if (startDeadlineTimer !== undefined) {
    clearTimeout(startDeadlineTimer);
  }
  if (startOutcome === "timeout") {
    throw new Error("installer never started the download before timeout");
  }
  if (typeof startOutcome === "object" && "exited" in startOutcome) {
    throw new Error(`installer exited ${startOutcome.exited} before download started`);
  }
  // Installer holds the lock while waiting on the stalled download.
  await access(lockPath);

  child.kill("SIGINT");

  // Bound wait: SIGKILL after 3s so the suite cannot hang if traps misbehave.
  const killTimer = setTimeout(() => {
    if (child.pid !== undefined && !childExited) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  }, 3_000);
  let exitCode: number | null;
  try {
    exitCode = await exitPromise;
  } finally {
    clearTimeout(killTimer);
  }
  assert.equal(exitCode, 130);

  // Close the stalled HTTP fixture before further assertions so the event loop
  // is not held open by the half-open response.
  await closeServer();

  // No activation: ownership and active executable must not exist after signal.
  await assert.rejects(access(path.join(prefix, ".1667-install.json")));
  await assert.rejects(access(path.join(prefix, "1667")));
  // Lock file stays on disk; cleanup releases the advisory hold so a successor can acquire.
  const lockStat = await stat(lockPath);
  assert.equal(lockStat.isFile(), true);
  const lock = await acquireInstallationLock(prefix);
  await lock.release();
});

test("stalled download respects curl max-time and releases install lock", async (t) => {
  // Integration regression: both URL branches embed --connect-timeout and
  // --max-time. A hung response body must not hold the Install Root lock past
  // the overall transfer deadline.
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-stall-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const archivesDir = path.join(root, "archives");
  const digests = await writePublishedArchives(archivesDir, INSTALL_VERSION);
  const openResponses: ServerResponse[] = [];
  let resolveDownloadStarted: (() => void) | null = null;
  const downloadStarted = new Promise<void>((resolve) => {
    resolveDownloadStarted = resolve;
  });
  const server = createServer((_request, response) => {
    openResponses.push(response);
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": "1048576"
    });
    // Stall the body so curl must hit --max-time.
    if (resolveDownloadStarted !== null) {
      const done = resolveDownloadStarted;
      resolveDownloadStarted = null;
      done();
    }
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
  t.after(async () => {
    await closeServer();
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  const base = `http://127.0.0.1:${address.port}`;

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  assert.match(scriptBody, /--connect-timeout "\$DOWNLOAD_CONNECT_TIMEOUT_SEC"/);
  assert.match(scriptBody, /--max-time "\$DOWNLOAD_MAX_TIME_SEC"/);
  // Short deadlines so the suite stays bounded while still exercising the flags.
  const patched = scriptBody
    .replace(/DOWNLOAD_CONNECT_TIMEOUT_SEC=\d+/u, "DOWNLOAD_CONNECT_TIMEOUT_SEC=1")
    .replace(/DOWNLOAD_MAX_TIME_SEC=\d+/u, "DOWNLOAD_MAX_TIME_SEC=2");
  assert.match(patched, /DOWNLOAD_MAX_TIME_SEC=2/);

  const scriptPath = path.join(root, "install-stall.sh");
  await writeFile(scriptPath, patched, { mode: 0o755 });
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);
  const lockPath = path.join(prefix, ".1667-install.lock");

  const started = Date.now();
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
  t.after(() => {
    if (!childExited && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Not a process-group leader or already gone.
      }
    }
  });

  let startDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = new Promise<"timeout">((resolve) => {
    startDeadlineTimer = setTimeout(() => resolve("timeout"), 5_000);
  });
  const startOutcome = await Promise.race([
    downloadStarted.then(() => "started" as const),
    startDeadline,
    exitPromise.then((code) => ({ exited: code }))
  ]);
  if (startDeadlineTimer !== undefined) {
    clearTimeout(startDeadlineTimer);
  }
  if (startOutcome === "timeout") {
    throw new Error("installer never started the download before timeout");
  }
  if (typeof startOutcome === "object" && "exited" in startOutcome) {
    throw new Error(`installer exited ${startOutcome.exited} before download started`);
  }
  await access(lockPath);

  // Outer bound: max-time=2 plus shell cleanup slack; must not hang forever.
  const killTimer = setTimeout(() => {
    if (child.pid !== undefined && !childExited) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  }, 8_000);
  let exitCode: number | null;
  try {
    exitCode = await exitPromise;
  } finally {
    clearTimeout(killTimer);
  }
  assert.notEqual(exitCode, 0, "stalled download must fail the installer");
  assert.ok(Date.now() - started < 8_000, "download max-time must bound the install");

  await closeServer();

  await assert.rejects(access(path.join(prefix, ".1667-install.json")));
  await assert.rejects(access(path.join(prefix, "1667")));
  const lockStat = await stat(lockPath);
  assert.equal(lockStat.isFile(), true);
  const lock = await acquireInstallationLock(prefix);
  await lock.release();
});

test("bounded probe kills hanging TERM-resistant candidate and releases lock", async (t) => {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  const root = await mkdtemp(path.join(homeScratch, "install-probe-hang-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const hostTarget = hostPublishedTarget();
  if (hostTarget === null) {
    t.skip("Host is not a published release target");
    return;
  }

  const { releaseArchiveFileName } = await import("../scripts/release-archive.js");
  const {
    execFileAsync,
    sha256File
  } = await import("./release-install-script-fixture.js");
  const { readFile: readFileFn } = await import("node:fs/promises");

  // Hang forever; ignore TERM so only the watchdog SIGKILL reaps the child.
  const hangStub = `#!/bin/sh
trap '' TERM INT
while true; do sleep 3600; done
`;
  const archivesDir = path.join(root, "archives");
  const digests = await writePublishedArchives(archivesDir, INSTALL_VERSION);
  const hostArchive = releaseArchiveFileName(INSTALL_VERSION, hostTarget);
  const archivePath = path.join(archivesDir, hostArchive);
  const stage = path.join(root, "hang-stage");
  await mkdir(stage, { recursive: true });
  const stem = hostArchive.replace(/\.tar\.gz$/u, "");
  const dir = path.join(stage, stem);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "1667"), hangStub, { mode: 0o755 });
  await writeFile(path.join(dir, "LICENSE"), "LICENSE\n");
  await writeFile(path.join(dir, "NOTICE"), "NOTICE\n");
  await writeFile(path.join(dir, "build-manifest.json"), "{}\n");
  await writeFile(path.join(dir, "sbom.spdx.json"), "{}\n");
  await execFileAsync("tar", ["-czf", archivePath, "-C", stage, stem]);
  digests[hostArchive] = sha256File(await readFileFn(archivePath));

  const server = createServer((request, response) => {
    const file = path.join(archivesDir, path.basename(request.url ?? ""));
    void readFileFn(file)
      .then((bytes) => {
        response.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": String(bytes.byteLength)
        });
        response.end(bytes);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address missing");
  const base = `http://127.0.0.1:${address.port}`;

  const scriptBody = renderInstallScriptsForVersion({
    version: INSTALL_VERSION,
    repository: INSTALL_REPO,
    digests,
    assetBaseUrl: base
  })["install-beta.sh"]!;
  assert.match(scriptBody, /run_bounded_probe/);
  assert.match(scriptBody, /exec 9>&-/);
  assert.match(scriptBody, /PROBE_TIMEOUT_SEC=/);
  assert.match(scriptBody, /stop_probe/);
  // Shorten probe bound for the suite without GNU timeout.
  const shortened = scriptBody.replace(
    /PROBE_TIMEOUT_SEC=5/u,
    "PROBE_TIMEOUT_SEC=2"
  );
  const scriptPath = path.join(root, "install-hang.sh");
  await writeFile(scriptPath, shortened, { mode: 0o755 });
  const prefix = path.join(root, "prefix");
  await mkdir(prefix, { mode: 0o755 });
  await chmod(prefix, 0o755);

  const started = Date.now();
  await assert.rejects(
    execFileAsync("sh", [scriptPath, "--prefix", prefix], {
      cwd: root,
      timeout: 20_000
    }),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const extra = error as Error & { stderr?: string | Buffer };
      const stderr = typeof extra.stderr === "string"
        ? extra.stderr
        : Buffer.isBuffer(extra.stderr)
          ? extra.stderr.toString("utf8")
          : "";
      return /Candidate version probe failed/i.test(`${error.message}\n${stderr}`);
    }
  );
  const elapsed = Date.now() - started;
  // Bound must fire well before an unbounded hang (2s + escalate + margin).
  assert.ok(elapsed < 15_000, `probe bound took too long: ${elapsed}ms`);

  await assert.rejects(access(path.join(prefix, ".1667-install.json")));
  await assert.rejects(access(path.join(prefix, "1667")));
  // Lock released so a successor can acquire.
  const lock = await acquireInstallationLock(prefix);
  await lock.release();
});
