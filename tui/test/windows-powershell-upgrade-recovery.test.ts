import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readReleaseExecutableIdentity } from "../../shared/executable-probe.js";
import { INSTALL_OWNERSHIP_FILE } from "../../shared/install-ownership-record.js";
import { INSTALL_LOCK_FILE } from "../../shared/install-layout.js";
import {
  releaseTargetForArtifact,
  type PublishedPlatformPackage
} from "../../shared/release-targets.js";
import { executeUpgradeCli } from "../src/upgrade-cli.js";
import { startWindowsUpgradeHandoff } from "../src/windows-upgrade-handoff.js";
import { recoverWindowsUpgradeFailure } from "../src/windows-upgrade-recovery.js";
import { WINDOWS_UPGRADE_FAILURE_FILE } from "../src/windows-upgrade-state.js";
import {
  buildCanonicalPlatformPackage,
  fakeManagedRegistry
} from "./managed-package-fixture.js";
import {
  removeWindowsHandoffScratch,
  windowsTestExecutable
} from "./windows-powershell-upgrade-fixture.js";

const TARGET = "windows-x64" as const;
const PACKAGE = releaseTargetForArtifact(TARGET).packageName as PublishedPlatformPackage;
const CURRENT = "1.2.3";
const NEXT = "2.0.0-beta.1";

test("a rolled-back Windows handoff is visible and the next upgrade retries", async () => {
  if (process.platform !== "win32") return;

  const scratch = mkdtempSync(path.join(tmpdir(), "1667-windows-recovery-test-"));
  let ownershipLocker: ChildProcess | undefined;
  try {
    const installRoot = path.join(scratch, "installed");
    const activePath = path.join(installRoot, "1667.exe");
    const failedWorkRoot = path.join(installRoot, ".1667-upgrade.failure-integration");
    const failedCandidate = path.join(failedWorkRoot, "1667-candidate.exe");
    const failurePath = path.join(installRoot, WINDOWS_UPGRADE_FAILURE_FILE);
    const ownershipPath = path.join(installRoot, INSTALL_OWNERSHIP_FILE);
    mkdirSync(failedWorkRoot, { recursive: true });
    writeFileSync(activePath, windowsTestExecutable(scratch, CURRENT, "recovery-current"));
    writeFileSync(failedCandidate, windowsTestExecutable(scratch, NEXT, "recovery-failed"));
    writeFileSync(ownershipPath, `${JSON.stringify({
      schemaVersion: 1,
      product: "1667",
      installationId: "0123456789abcdef0123456789abcdef",
      method: "powershell",
      channel: "stable",
      installRoot,
      executable: activePath,
      artifactTarget: TARGET
    })}\n`);
    const lockerPath = path.join(scratch, "locker.exe");
    copyFileSync(activePath, lockerPath);
    ownershipLocker = spawn(lockerPath, ["--hold-file", ownershipPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    await once(ownershipLocker.stdout!, "data");
    const authority = {
      kind: "powershell" as const,
      channel: "stable" as const,
      installRoot,
      executable: activePath
    };

    await startWindowsUpgradeHandoff({
      authority,
      currentVersion: CURRENT,
      targetVersion: NEXT,
      channel: "beta",
      updateChannel: true,
      candidatePath: failedCandidate,
      candidateSha256: createHash("sha256")
        .update(readFileSync(failedCandidate))
        .digest("hex"),
      workRoot: failedWorkRoot
    });
    await waitForFailureMarker(failurePath, failedWorkRoot);
    const failure = JSON.parse(readFileSync(failurePath, "utf8")) as {
      activeState: string;
      message: string;
    };
    expect(failure).toMatchObject({
      fromVersion: CURRENT,
      targetVersion: NEXT,
      targetChannel: "beta",
      activeState: "restored"
    });
    expect(failure.message.length > 0).toBe(true);
    expect((await readReleaseExecutableIdentity(activePath)).productVersion).toBe(CURRENT);
    expect(JSON.parse(readFileSync(ownershipPath, "utf8"))).toMatchObject({
      channel: "stable"
    });

    const lockerClose = once(ownershipLocker, "close");
    expect(ownershipLocker.kill()).toBe(true);
    await lockerClose;
    ownershipLocker = undefined;

    const executableBody = windowsTestExecutable(scratch, NEXT, "recovery-retry");
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET,
      executableBody
    });
    let retryHandoffs = 0;
    const retry = await executeUpgradeCli(["--channel=beta", "--json"], {
      observation: { currentVersion: CURRENT, platformPackage: PACKAGE },
      authority,
      registry: fakeManagedRegistry(NEXT, PACKAGE, pkg.integrity, pkg.tarballUrl),
      fetcher: async (input: string | URL | Request) => {
        if (String(input) === pkg.tarballUrl) {
          return new Response(new Uint8Array(pkg.bytes), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      },
      startWindowsUpgradeHandoff: async (request) => {
        retryHandoffs += 1;
        expect(request.workRoot).not.toBe(failedWorkRoot);
        expect(existsSync(failurePath)).toBe(false);
        expect(existsSync(path.join(failedWorkRoot, "request.json"))).toBe(false);
        expect((await readReleaseExecutableIdentity(request.candidatePath)).productVersion)
          .toBe(NEXT);
      }
    });

    expect(retry).toMatchObject({ exitCode: 0 });
    expect(retry.stderr).toBe(
      "Warning: Previous Windows upgrade did not finish: "
      + `${failure.message}${failure.message.endsWith(".") ? "" : "."} `
      + "Continuing with this upgrade command.\n"
    );
    expect(retry.stderr).not.toContain("Retrying");
    expect(JSON.parse(retry.stdout)).toEqual({
      status: "staged",
      current: CURRENT,
      latest: NEXT,
      target: NEXT,
      channel: "beta",
      method: "powershell",
      restartRequired: true,
      command: null,
      error: null
    });
    expect(retry.envelope).toEqual(JSON.parse(retry.stdout));
    expect(retryHandoffs).toBe(1);
    expect((await readReleaseExecutableIdentity(activePath)).productVersion).toBe(CURRENT);
    expect(JSON.parse(readFileSync(ownershipPath, "utf8")))
      .toMatchObject({ channel: "stable" });
  } finally {
    if (ownershipLocker?.exitCode === null) {
      const lockerClose = once(ownershipLocker, "close");
      ownershipLocker.kill();
      await lockerClose;
    }
    await removeWindowsHandoffScratch(scratch);
  }
}, 45_000);

test("post-commit cleanup failure preserves the successful Windows upgrade", async () => {
  if (process.platform !== "win32") return;

  const scratch = mkdtempSync(path.join(tmpdir(), "1667-windows-cleanup-test-"));
  let activeProcess: ChildProcess | undefined;
  let transactionLocker: ChildProcess | undefined;
  let completionWaiter: ChildProcess | undefined;
  try {
    const installRoot = path.join(scratch, "installed");
    const activePath = path.join(installRoot, "1667.exe");
    const workRoot = path.join(installRoot, ".1667-upgrade.cleanup-integration");
    const candidatePath = path.join(workRoot, "1667-candidate.exe");
    const transactionPath = path.join(workRoot, "transaction.json");
    const ownershipPath = path.join(installRoot, INSTALL_OWNERSHIP_FILE);
    const failurePath = path.join(installRoot, WINDOWS_UPGRADE_FAILURE_FILE);
    mkdirSync(workRoot, { recursive: true });
    writeFileSync(activePath, windowsTestExecutable(scratch, CURRENT, "cleanup-current"));
    writeFileSync(candidatePath, windowsTestExecutable(scratch, NEXT, "cleanup-candidate"));
    writeFileSync(ownershipPath, `${JSON.stringify({
      schemaVersion: 1,
      product: "1667",
      installationId: "fedcba9876543210fedcba9876543210",
      method: "powershell",
      channel: "stable",
      installRoot,
      executable: activePath,
      artifactTarget: TARGET
    })}\n`);
    const authority = {
      kind: "powershell" as const,
      channel: "stable" as const,
      installRoot,
      executable: activePath
    };

    activeProcess = spawn(activePath, ["--hold"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    await once(activeProcess.stdout!, "data");
    const lockerPath = path.join(scratch, "cleanup-locker.exe");
    copyFileSync(activePath, lockerPath);
    transactionLocker = spawn(lockerPath, ["--wait-hold-file", transactionPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const transactionLocked = once(transactionLocker.stdout!, "data");

    await startWindowsUpgradeHandoff({
      authority,
      currentVersion: CURRENT,
      targetVersion: NEXT,
      channel: "beta",
      updateChannel: true,
      candidatePath,
      candidateSha256: createHash("sha256")
        .update(readFileSync(candidatePath))
        .digest("hex"),
      workRoot
    });
    await transactionLocked;
    expect(activeProcess.exitCode).toBe(null);
    expect((await readReleaseExecutableIdentity(activePath)).productVersion).toBe(CURRENT);

    const activeClose = once(activeProcess, "close");
    expect(activeProcess.kill()).toBe(true);
    await activeClose;
    activeProcess = undefined;

    completionWaiter = spawn(lockerPath, [
      "--wait-hold-file",
      path.join(installRoot, INSTALL_LOCK_FILE)
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    await once(completionWaiter.stdout!, "data");
    const completionClose = once(completionWaiter, "close");
    expect(completionWaiter.kill()).toBe(true);
    await completionClose;
    completionWaiter = undefined;

    expect(await recoverWindowsUpgradeFailure({ ...authority, channel: "beta" })).toBe(null);
    expect(existsSync(transactionPath)).toBe(true);
    expect(existsSync(failurePath)).toBe(false);
    expect((await readReleaseExecutableIdentity(activePath)).productVersion).toBe(NEXT);
    expect(JSON.parse(readFileSync(ownershipPath, "utf8"))).toMatchObject({
      channel: "beta",
      installRoot,
      executable: activePath
    });

    const lockerClose = once(transactionLocker, "close");
    expect(transactionLocker.kill()).toBe(true);
    await lockerClose;
    transactionLocker = undefined;
  } finally {
    if (activeProcess?.exitCode === null) {
      const activeClose = once(activeProcess, "close");
      activeProcess.kill();
      await activeClose;
    }
    if (transactionLocker?.exitCode === null) {
      const lockerClose = once(transactionLocker, "close");
      transactionLocker.kill();
      await lockerClose;
    }
    if (completionWaiter?.exitCode === null) {
      const completionClose = once(completionWaiter, "close");
      completionWaiter.kill();
      await completionClose;
    }
    await removeWindowsHandoffScratch(scratch);
  }
}, 45_000);

for (const scenario of [
  { name: "channel switch", updateChannel: true, savedChannel: "beta" },
  { name: "exact version", updateChannel: false, savedChannel: "stable" }
] as const) {
  test(`concurrent Windows ${scenario.name} handoffs converge safely`, async () => {
    if (process.platform !== "win32") return;

    const scratch = mkdtempSync(path.join(tmpdir(), "1667-windows-concurrent-test-"));
    let activeProcess: ChildProcess | undefined;
    try {
      const installRoot = path.join(scratch, "installed");
      const activePath = path.join(installRoot, "1667.exe");
      const ownershipPath = path.join(installRoot, INSTALL_OWNERSHIP_FILE);
      const failurePath = path.join(installRoot, WINDOWS_UPGRADE_FAILURE_FILE);
      const workRoots = [
        path.join(installRoot, ".1667-upgrade.concurrent-a"),
        path.join(installRoot, ".1667-upgrade.concurrent-b")
      ];
      for (const workRoot of workRoots) mkdirSync(workRoot, { recursive: true });
      writeFileSync(activePath, windowsTestExecutable(scratch, CURRENT, "concurrent-current"));
      const candidate = windowsTestExecutable(scratch, NEXT, "concurrent-candidate");
      for (const workRoot of workRoots) {
        writeFileSync(path.join(workRoot, "1667-candidate.exe"), candidate);
      }
      writeFileSync(ownershipPath, `${JSON.stringify({
        schemaVersion: 1,
        product: "1667",
        installationId: "00112233445566778899aabbccddeeff",
        method: "powershell",
        channel: "stable",
        installRoot,
        executable: activePath,
        artifactTarget: TARGET
      })}\n`);
      const authority = {
        kind: "powershell" as const,
        channel: "stable" as const,
        installRoot,
        executable: activePath
      };
      activeProcess = spawn(activePath, ["--hold"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      await once(activeProcess.stdout!, "data");

      await Promise.all(workRoots.map(async (workRoot) => {
        const candidatePath = path.join(workRoot, "1667-candidate.exe");
        await startWindowsUpgradeHandoff({
          authority,
          currentVersion: CURRENT,
          targetVersion: NEXT,
          channel: "beta",
          updateChannel: scenario.updateChannel,
          candidatePath,
          candidateSha256: createHash("sha256")
            .update(readFileSync(candidatePath))
            .digest("hex"),
          workRoot
        });
      }));
      await waitForAnyTransaction(workRoots, failurePath);

      const activeClose = once(activeProcess, "close");
      expect(activeProcess.kill()).toBe(true);
      await activeClose;
      activeProcess = undefined;

      await waitForConcurrentSuccess(
        activePath,
        ownershipPath,
        workRoots,
        failurePath,
        scenario.savedChannel
      );
      expect(await recoverWindowsUpgradeFailure({
        ...authority,
        channel: scenario.savedChannel
      })).toBe(null);
      expect(existsSync(failurePath)).toBe(false);
      expect((await readReleaseExecutableIdentity(activePath)).productVersion).toBe(NEXT);
      expect(JSON.parse(readFileSync(ownershipPath, "utf8"))).toMatchObject({
        channel: scenario.savedChannel,
        installRoot,
        executable: activePath
      });
      expect(workRoots.some((workRoot) => existsSync(workRoot))).toBe(false);
    } finally {
      if (activeProcess?.exitCode === null) {
        const activeClose = once(activeProcess, "close");
        activeProcess.kill();
        await activeClose;
      }
      await removeWindowsHandoffScratch(scratch);
    }
  }, 60_000);
}

async function waitForFailureMarker(failurePath: string, workRoot: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(failurePath)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  const helperError = path.join(workRoot, "error.txt");
  throw new Error(existsSync(helperError)
    ? readFileSync(helperError, "utf8").trim()
    : "Windows handoff did not report its failure");
}

async function waitForAnyTransaction(
  workRoots: readonly string[],
  failurePath: string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(failurePath)) {
      throw new Error(readFileSync(failurePath, "utf8"));
    }
    if (workRoots.some((root) => existsSync(path.join(root, "transaction.json")))) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Concurrent Windows handoffs did not reach the replacement attempt");
}

async function waitForConcurrentSuccess(
  activePath: string,
  ownershipPath: string,
  workRoots: readonly string[],
  failurePath: string,
  expectedChannel: "stable" | "beta"
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(failurePath)) {
      throw new Error(readFileSync(failurePath, "utf8"));
    }
    try {
      const ownership = JSON.parse(readFileSync(ownershipPath, "utf8")) as {
        channel?: unknown;
      };
      if (ownership.channel === expectedChannel
        && workRoots.every((workRoot) => !existsSync(workRoot))) {
        const identity = await readReleaseExecutableIdentity(activePath);
        if (identity.productVersion === NEXT) return;
      }
    } catch {
      // The other helper can be replacing an observed file.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  const errors = workRoots
    .map((root) => path.join(root, "error.txt"))
    .filter(existsSync)
    .map((file) => readFileSync(file, "utf8").trim());
  throw new Error(errors.join("; ") || "Concurrent Windows handoffs did not finish");
}
