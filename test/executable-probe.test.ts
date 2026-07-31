/**
 * Behavior tests for executable probe termination: AbortSignal, timeout, and
 * stdout-bound failures must reap the full POSIX process group (including
 * SIGTERM-ignoring descendants that hold inherited pipes) before the Promise
 * rejects, so a mutation lock held around the probe cannot release while
 * descendants still live.
 */
import assert from "node:assert/strict";
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
import {
  EXECUTABLE_PROBE_MAX_STDOUT_BYTES,
  EXECUTABLE_PROBE_SETTLEMENT_DEADLINE_MS,
  EXECUTABLE_PROBE_TERMINATION_GRACE_MS,
  ExecutableProbeError,
  readReleaseExecutableIdentity
} from "../shared/executable-probe.js";
import { acquireInstallationLock } from "../tui/src/install-lock.js";
import {
  assertProcessIsNotRunning,
  assertProcessIsReaped,
  processIsRunning
} from "./process-liveness.js";

async function makeRoot(label: string): Promise<string> {
  const homeScratch = path.join(homedir(), ".cache", "1667-tests");
  await mkdir(homeScratch, { recursive: true, mode: 0o755 });
  await chmod(homeScratch, 0o755);
  return mkdtemp(path.join(homeScratch, label));
}

async function waitForFile(filePath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function readPid(filePath: string): Promise<number> {
  const text = (await readFile(filePath, "utf8")).trim();
  const pid = Number(text);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `invalid pid in ${filePath}: ${text}`);
  return pid;
}

/**
 * Probe that ignores SIGTERM, spawns a descendant that also ignores SIGTERM and
 * inherits stdout so Node close cannot fire until the whole group is killed.
 * Use $! for the background PID: $$ inside a POSIX subshell is still the parent.
 */
function stickyProbeScript(probePidFile: string, descendantPidFile: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then
  (
    trap '' TERM
    # Inherit stdout/stderr; hold forever so unreaped descendants block close.
    while true; do sleep 3600; done
  ) &
  printf '%s\\n' "$!" > ${JSON.stringify(descendantPidFile)}
  printf '%s\\n' "$$" > ${JSON.stringify(probePidFile)}
  trap '' TERM
  while true; do sleep 3600; done
fi
exit 1
`;
}

/** Best-effort kill of recorded fixture PIDs after a failed or aborted test. */
function killFixturePid(pid: number | null): void {
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

test("abort reaps SIGTERM-ignoring probe and descendant before reject", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
  timeout: 10_000
}, async (t) => {
  const root = await makeRoot("probe-abort-");
  let probePid: number | null = null;
  let descendantPid: number | null = null;
  t.after(async () => {
    killFixturePid(probePid);
    killFixturePid(descendantPid);
    await rm(root, { recursive: true, force: true });
  });
  const probePidFile = path.join(root, "probe.pid");
  const descendantPidFile = path.join(root, "descendant.pid");
  const exe = path.join(root, "1667");
  await writeFile(exe, stickyProbeScript(probePidFile, descendantPidFile), { mode: 0o755 });
  await chmod(exe, 0o755);

  const controller = new AbortController();
  const probe = readReleaseExecutableIdentity(exe, {
    signal: controller.signal,
    timeoutMs: 8_000
  });
  // Observe the promise so a mid-test failure cannot leave an unhandled rejection.
  const observed = probe.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await waitForFile(probePidFile);
  await waitForFile(descendantPidFile);
  probePid = await readPid(probePidFile);
  descendantPid = await readPid(descendantPidFile);
  assert.notEqual(probePid, descendantPid);
  assert.equal(processIsRunning(probePid), true);
  assert.equal(processIsRunning(descendantPid), true);

  // Both ignore SIGTERM; without group SIGKILL, close would hang on inherited pipes.
  controller.abort();
  const result = await observed;
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.error instanceof ExecutableProbeError);
  assert.match((result.error as ExecutableProbeError).message, /interrupted/u);

  // Settlement proves reaping: both must already be gone.
  assertProcessIsReaped(probePid, "probe");
  assertProcessIsNotRunning(descendantPid, "descendant");
  // Grace is short; abort must not leave timers that outlive settlement.
  assert.ok(
    EXECUTABLE_PROBE_TERMINATION_GRACE_MS > 0
    && EXECUTABLE_PROBE_TERMINATION_GRACE_MS < 5_000
  );
});

test("probe abort under Install Root lock reaps before lock can release", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
  timeout: 10_000
}, async (t) => {
  const root = await makeRoot("probe-lock-");
  let probePid: number | null = null;
  let descendantPid: number | null = null;
  t.after(async () => {
    killFixturePid(probePid);
    killFixturePid(descendantPid);
    await rm(root, { recursive: true, force: true });
  });
  const installRoot = path.join(root, "bin");
  await mkdir(installRoot, { mode: 0o755 });
  await chmod(installRoot, 0o755);
  const probePidFile = path.join(root, "probe.pid");
  const descendantPidFile = path.join(root, "descendant.pid");
  const exe = path.join(installRoot, "1667");
  await writeFile(exe, stickyProbeScript(probePidFile, descendantPidFile), { mode: 0o755 });
  await chmod(exe, 0o755);

  const lock = await acquireInstallationLock(installRoot);
  let released = false;
  t.after(async () => {
    if (!released) await lock.release();
  });

  const controller = new AbortController();
  // Same shape as withManagedInstallMutation: probe under lock, release in finally.
  const mutation = (async () => {
    try {
      return await readReleaseExecutableIdentity(exe, {
        signal: controller.signal,
        timeoutMs: 8_000
      });
    } finally {
      // If reaping were async after reject, descendants could outlive release.
      await lock.release();
      released = true;
    }
  })();

  await waitForFile(probePidFile);
  await waitForFile(descendantPidFile);
  probePid = await readPid(probePidFile);
  descendantPid = await readPid(descendantPidFile);
  assert.notEqual(probePid, descendantPid);
  controller.abort();
  await assert.rejects(mutation, (error: unknown) => error instanceof ExecutableProbeError);

  assertProcessIsReaped(probePid, "probe");
  assertProcessIsNotRunning(descendantPid, "descendant");
  // Lock is free only after the mutation finally ran; re-acquire proves release.
  const again = await acquireInstallationLock(installRoot);
  await again.release();
});

/**
 * Probe that escapes the process group via setsid while a descendant keeps
 * inherited stdout open. Group SIGKILL cannot reap the escaped writer, so
 * settlement must use the final deadline and close owned streams.
 *
 * Uses python3 os.setsid (portable on Darwin and Linux; the setsid(1) utility
 * is not present on macOS).
 */
function setsidEscapedProbeScript(
  probePidFile: string,
  escapedPidFile: string,
  escapeHelper: string
): string {
  return `#!/bin/sh
if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' "$$" > ${JSON.stringify(probePidFile)}
  # Escape the probe process group; keep inherited stdout/stderr open forever.
  # Redirect only stdin so the escaped writer still holds the Node pipes.
  python3 ${JSON.stringify(escapeHelper)} ${JSON.stringify(escapedPidFile)} </dev/null &
  trap '' TERM
  while true; do sleep 3600; done
fi
exit 1
`;
}

test("setsid descendant cannot keep probe promise open past settlement deadline", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
  timeout: 30_000
}, async (t) => {
  const root = await makeRoot("probe-setsid-");
  let probePid: number | null = null;
  let escapedPid: number | null = null;
  t.after(async () => {
    killFixturePid(probePid);
    killFixturePid(escapedPid);
    await rm(root, { recursive: true, force: true });
  });
  const probePidFile = path.join(root, "probe.pid");
  const escapedPidFile = path.join(root, "escaped.pid");
  const escapeHelper = path.join(root, "escape-session.py");
  await writeFile(
    escapeHelper,
    [
      "import os",
      "import sys",
      "import time",
      "os.setsid()",
      "open(sys.argv[1], 'w').write(str(os.getpid()) + chr(10))",
      "while True:",
      "    time.sleep(3600)",
      ""
    ].join("\n"),
    { mode: 0o644 }
  );
  const exe = path.join(root, "1667");
  await writeFile(
    exe,
    setsidEscapedProbeScript(probePidFile, escapedPidFile, escapeHelper),
    { mode: 0o755 }
  );
  await chmod(exe, 0o755);

  const controller = new AbortController();
  const probe = readReleaseExecutableIdentity(exe, {
    signal: controller.signal,
    timeoutMs: 8_000
  });
  const observed = probe.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await waitForFile(probePidFile);
  await waitForFile(escapedPidFile);
  probePid = await readPid(probePidFile);
  escapedPid = await readPid(escapedPidFile);
  assert.notEqual(probePid, escapedPid);
  assert.equal(processIsRunning(probePid), true);
  assert.equal(processIsRunning(escapedPid), true);

  controller.abort();
  const result = await observed;
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.error instanceof ExecutableProbeError);
  assert.match((result.error as ExecutableProbeError).message, /interrupted/u);

  // Probe group is reaped; escaped setsid child may still be alive until we clean it.
  assertProcessIsReaped(probePid, "probe");
  // The escaped writer holds the inherited pipe for 3600s, so the promise
  // settled only because the deadline closed the streams. The test timeout is
  // the bound. An elapsed-time assertion would add no proof, because a node
  // timer has no upper bound on a loaded machine.
  assert.ok(
    EXECUTABLE_PROBE_SETTLEMENT_DEADLINE_MS > 0
    && EXECUTABLE_PROBE_SETTLEMENT_DEADLINE_MS < 5_000
  );
  // Escaped writer may still hold the pipe from its side; test must not leak it.
  killFixturePid(escapedPid);
  escapedPid = null;
});

test("timeout reaps sticky process group before reject", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
  timeout: 30_000
}, async (t) => {
  const root = await makeRoot("probe-timeout-");
  let probePid: number | null = null;
  let descendantPid: number | null = null;
  t.after(async () => {
    killFixturePid(probePid);
    killFixturePid(descendantPid);
    await rm(root, { recursive: true, force: true });
  });
  const probePidFile = path.join(root, "probe.pid");
  const descendantPidFile = path.join(root, "descendant.pid");
  const exe = path.join(root, "1667");
  await writeFile(exe, stickyProbeScript(probePidFile, descendantPidFile), { mode: 0o755 });
  await chmod(exe, 0o755);

  // Timeout after pid files exist: the sticky tree is two shells and two writes,
  // which stay far inside this timeout even on a loaded machine.
  const probe = readReleaseExecutableIdentity(exe, { timeoutMs: 800 });
  const observed = probe.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await waitForFile(probePidFile);
  await waitForFile(descendantPidFile);
  probePid = await readPid(probePidFile);
  descendantPid = await readPid(descendantPidFile);
  assert.notEqual(probePid, descendantPid);

  const result = await observed;
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.error instanceof ExecutableProbeError);
  assert.match((result.error as ExecutableProbeError).message, /timed out/u);
  assertProcessIsReaped(probePid, "probe");
  assertProcessIsNotRunning(descendantPid, "descendant");
  // The probe rejected on its own timeout and did not wait out the 3600s sleep.
  // The test timeout is the bound, for the same reason as the setsid test above.
});

test("stdout-bound termination reaps before reject", {
  skip: process.platform === "win32" ? "POSIX process groups only" : false,
  timeout: 10_000
}, async (t) => {
  const root = await makeRoot("probe-stdout-");
  let probePid: number | null = null;
  let descendantPid: number | null = null;
  t.after(async () => {
    killFixturePid(probePid);
    killFixturePid(descendantPid);
    await rm(root, { recursive: true, force: true });
  });
  const probePidFile = path.join(root, "probe.pid");
  const descendantPidFile = path.join(root, "descendant.pid");
  const exe = path.join(root, "1667");
  // Flood stdout past the bound, then hang while ignoring SIGTERM (descendant too).
  const oversize = EXECUTABLE_PROBE_MAX_STDOUT_BYTES + 4096;
  const body = `#!/bin/sh
if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then
  (
    trap '' TERM
    while true; do sleep 3600; done
  ) &
  printf '%s\\n' "$!" > ${JSON.stringify(descendantPidFile)}
  printf '%s\\n' "$$" > ${JSON.stringify(probePidFile)}
  trap '' TERM
  # dd writes enough bytes to trip the bound while pipes stay open.
  dd if=/dev/zero bs=${oversize} count=1 2>/dev/null
  while true; do sleep 3600; done
fi
exit 1
`;
  await writeFile(exe, body, { mode: 0o755 });
  await chmod(exe, 0o755);

  const probe = readReleaseExecutableIdentity(exe, { timeoutMs: 8_000 });
  const observed = probe.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await waitForFile(probePidFile);
  await waitForFile(descendantPidFile);
  probePid = await readPid(probePidFile);
  descendantPid = await readPid(descendantPidFile);
  assert.notEqual(probePid, descendantPid);

  const result = await observed;
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.error instanceof ExecutableProbeError);
  assert.match((result.error as ExecutableProbeError).message, /stdout exceeded/u);
  assertProcessIsReaped(probePid, "probe");
  assertProcessIsNotRunning(descendantPid, "descendant");
});

test("successful probe still parses strict JSON identity", {
  timeout: 5_000
}, async (t) => {
  const root = await makeRoot("probe-ok-");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const identity = {
    schemaVersion: 1,
    product: "1667",
    productVersion: "1.2.3",
    buildKind: "release",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    sourceDirty: false,
    buildTimestamp: "2026-07-29T00:00:00.000Z",
    artifactTarget: "darwin-arm64",
    apiProtocolVersion: 10,
    minClientProtocolVersion: 10,
    maxClientProtocolVersion: 10
  };
  const exe = path.join(root, "1667");
  await writeFile(
    exe,
    `#!/bin/sh
if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
${JSON.stringify(identity)}
EOF
  exit 0
fi
exit 1
`,
    { mode: 0o755 }
  );
  await chmod(exe, 0o755);
  const parsed = await readReleaseExecutableIdentity(exe, { timeoutMs: 2_000 });
  assert.equal(parsed.productVersion, "1.2.3");
  assert.equal(parsed.artifactTarget, "darwin-arm64");
});

test("pre-aborted signal rejects promptly without spawning a hang", {
  timeout: 5_000
}, async () => {
  const controller = new AbortController();
  controller.abort();
  // Missing path: early abort must win before spawn work; must not hang on close.
  await assert.rejects(
    () => readReleaseExecutableIdentity(
      path.join(homedir(), ".cache", "1667-tests", "probe-missing-no-spawn"),
      { signal: controller.signal, timeoutMs: 8_000 }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ExecutableProbeError);
      assert.match(error.message, /interrupted/u);
      return true;
    }
  );
});

test("spawn failure rejects with probe-failed message after close", {
  timeout: 5_000
}, async () => {
  // ENOENT: Node emits error then close. Settlement must wait for close and keep
  // the prompt "Executable probe failed: …" shape (not a generic interrupt).
  const missing = path.join(
    homedir(),
    ".cache",
    "1667-tests",
    "probe-enoent-does-not-exist",
    "1667"
  );
  await assert.rejects(
    () => readReleaseExecutableIdentity(missing, { timeoutMs: 8_000 }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutableProbeError);
      assert.match(error.message, /^Executable probe failed:/u);
      return true;
    }
  );
  // The 5s test timeout is below the 8s probe timeout, so reaching this line
  // proves close followed the error and did not wait for the wall clock.
});

test("abort that races past the initial check is still observed", {
  timeout: 5_000
}, async () => {
  // Abort during addEventListener so the event fires with no listener yet (missed
  // event). Race-safe code re-checks signal.aborted after register and terminates.
  // Missing path keeps the fixture free of sticky process timing.
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  signal.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === "abort") {
      controller.abort();
    }
    return originalAdd(type, listener, options);
  }) as typeof signal.addEventListener;

  const missing = path.join(
    homedir(),
    ".cache",
    "1667-tests",
    "probe-abort-race-missing",
    "1667"
  );
  await assert.rejects(
    () => readReleaseExecutableIdentity(missing, { signal, timeoutMs: 8_000 }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutableProbeError);
      assert.match(error.message, /interrupted/u);
      return true;
    }
  );
});
