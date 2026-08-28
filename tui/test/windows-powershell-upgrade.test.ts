import { expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readReleaseExecutableIdentity } from "../../shared/executable-probe.js";
import { INSTALL_OWNERSHIP_FILE } from "../../shared/install-ownership-record.js";
import {
  releaseTargetForArtifact,
  type PublishedPlatformPackage
} from "../../shared/release-targets.js";
import { executeUpgradeCli } from "../src/upgrade-cli.js";
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

test("a PowerShell beta switch verifies the npm Candidate and starts the handoff", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "1667-windows-upgrade-test-"));
  const workRoots = new Set<string>();
  try {
    const executableBody = windowsTestExecutable(scratch, NEXT);
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET,
      executableBody
    });
    const registry = fakeManagedRegistry(NEXT, PACKAGE, pkg.integrity, pkg.tarballUrl);
    const installRoot = path.join(scratch, "installed");
    mkdirSync(installRoot);
    const starts: Array<{
      readonly channel: string;
      readonly updateChannel: boolean;
      readonly currentVersion: string;
      readonly targetVersion: string;
      readonly candidateVersion: string;
    }> = [];
    const dependencies = {
      observation: { currentVersion: CURRENT, platformPackage: PACKAGE },
      authority: {
        kind: "powershell" as const,
        channel: "stable" as const,
        installRoot,
        executable: path.join(installRoot, "1667.exe")
      },
      registry,
      fetcher: async (input: string | URL | Request) => {
        if (String(input) === pkg.tarballUrl) {
          return new Response(new Uint8Array(pkg.bytes), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      },
      startWindowsUpgradeHandoff: async (request: {
        readonly channel: string;
        readonly updateChannel: boolean;
        readonly currentVersion: string;
        readonly targetVersion: string;
        readonly candidatePath: string;
        readonly workRoot: string;
      }) => {
        workRoots.add(request.workRoot);
        const identity = await readReleaseExecutableIdentity(request.candidatePath);
        starts.push({
          channel: request.channel,
          updateChannel: request.updateChannel,
          currentVersion: request.currentVersion,
          targetVersion: request.targetVersion,
          candidateVersion: identity.productVersion
        });
      }
    };

    const human = await executeUpgradeCli(["--channel=beta"], dependencies);
    expect(human).toMatchObject({ exitCode: 0, stderr: "" });
    expect(human.stdout).toBe(
      `1667 ${NEXT} is verified and staged.\n`
        + "Windows will finish the upgrade after this command exits. "
        + "Start 1667.exe again after it finishes.\n"
    );

    const json = await executeUpgradeCli(["--channel=beta", "--json"], dependencies);
    expect(json).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(json.stdout)).toEqual({
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
    expect(json.envelope).toEqual(JSON.parse(json.stdout));
    expect(/attest|gh release|install-beta\.ps1|EncodedCommand/iu.test(json.stdout)).toBe(false);
    expect(starts).toEqual([
      {
        channel: "beta",
        updateChannel: true,
        currentVersion: CURRENT,
        targetVersion: NEXT,
        candidateVersion: NEXT
      },
      {
        channel: "beta",
        updateChannel: true,
        currentVersion: CURRENT,
        targetVersion: NEXT,
        candidateVersion: NEXT
      }
    ]);
  } finally {
    for (const workRoot of workRoots) {
      rmSync(workRoot, { recursive: true, force: true });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a PowerShell beta check is read-only", async () => {
  let handoffs = 0;
  let downloads = 0;
  const checked = await executeUpgradeCli(["--check", "--channel=beta", "--json"], {
    observation: { currentVersion: CURRENT, platformPackage: PACKAGE },
    authority: {
      kind: "powershell",
      channel: "stable",
      installRoot: "C:\\Program Files\\1667",
      executable: "C:\\Program Files\\1667\\1667.exe"
    },
    registry: fakeManagedRegistry(
      NEXT,
      PACKAGE,
      `sha512-${"A".repeat(86)}==`,
      "https://registry.npmjs.org/@1667-ai/cli-win32-x64/-/cli-win32-x64-2.0.0-beta.1.tgz"
    ),
    fetcher: async () => {
      downloads += 1;
      throw new Error("a check must not download a package");
    },
    startWindowsUpgradeHandoff: () => {
      handoffs += 1;
      throw new Error("a check must not start a handoff");
    }
  });

  expect(checked).toMatchObject({ exitCode: 0, stderr: "" });
  expect(JSON.parse(checked.stdout)).toMatchObject({
    status: "available",
    current: CURRENT,
    latest: NEXT,
    target: NEXT,
    channel: "beta",
    method: "powershell",
    restartRequired: false,
    command: null,
    error: null
  });
  expect(downloads).toBe(0);
  expect(handoffs).toBe(0);
});

test("a same-version PowerShell beta switch saves the channel without a handoff", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "1667-windows-channel-test-"));
  let downloads = 0;
  let handoffs = 0;
  const saved: string[] = [];
  try {
    const installRoot = process.platform === "win32"
      ? path.join(scratch, "installed")
      : "C:\\Program Files\\1667";
    const executable = path.win32.join(installRoot, "1667.exe");
    if (process.platform === "win32") {
      mkdirSync(installRoot);
      writeFileSync(path.join(installRoot, INSTALL_OWNERSHIP_FILE), `${JSON.stringify({
        schemaVersion: 1,
        product: "1667",
        installationId: "0123456789abcdef0123456789abcdef",
        method: "powershell",
        channel: "stable",
        installRoot,
        executable,
        artifactTarget: TARGET
      })}\n`);
    }
    const switched = await executeUpgradeCli(["--channel=beta", "--json"], {
      observation: { currentVersion: NEXT, platformPackage: PACKAGE },
      authority: {
        kind: "powershell",
        channel: "stable",
        installRoot,
        executable
      },
      registry: fakeManagedRegistry(
        NEXT,
        PACKAGE,
        `sha512-${"A".repeat(86)}==`,
        "https://registry.npmjs.org/@1667-ai/cli-win32-x64/-/cli-win32-x64-2.0.0-beta.1.tgz"
      ),
      fetcher: async () => {
        downloads += 1;
        throw new Error("a same-version channel switch must not download a package");
      },
      startWindowsUpgradeHandoff: () => {
        handoffs += 1;
        throw new Error("a same-version channel switch must not start a handoff");
      },
      ...(process.platform === "win32"
        ? {}
        : {
            saveWindowsUpgradeChannel: (_authority: unknown, channel: string) => {
              saved.push(channel);
            }
          })
    });

    expect(switched).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(switched.stdout)).toEqual({
      status: "up-to-date",
      current: NEXT,
      latest: NEXT,
      target: null,
      channel: "beta",
      method: "powershell",
      restartRequired: false,
      command: null,
      error: null
    });
    if (process.platform === "win32") {
      expect(JSON.parse(
        readFileSync(path.join(installRoot, INSTALL_OWNERSHIP_FILE), "utf8")
      )).toMatchObject({ channel: "beta" });
    } else {
      expect(saved).toEqual(["beta"]);
    }
    expect(downloads).toBe(0);
    expect(handoffs).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the detached Windows handoff waits for running 1667, then replaces it", async () => {
  if (process.platform !== "win32") return;

  const scratch = mkdtempSync(path.join(tmpdir(), "1667-windows-handoff-test-"));
  let activeProcess: ChildProcess | undefined;
  try {
    const installRoot = path.join(scratch, "installed");
    const activePath = path.join(installRoot, "1667.exe");
    const workRoot = path.join(installRoot, ".1667-upgrade.integration");
    const candidatePath = path.join(workRoot, "1667-candidate.exe");
    mkdirSync(workRoot, { recursive: true });
    const currentExecutable = windowsTestExecutable(scratch, CURRENT, "current");
    const currentBytes = Buffer.isBuffer(currentExecutable)
      ? currentExecutable
      : Buffer.from(currentExecutable);
    writeFileSync(activePath, currentBytes);
    writeFileSync(candidatePath, windowsTestExecutable(scratch, NEXT, "candidate"));
    chmodSync(activePath, 0o755);
    chmodSync(candidatePath, 0o755);
    const ownershipPath = path.join(installRoot, INSTALL_OWNERSHIP_FILE);
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
    activeProcess = spawn(activePath, ["--hold"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    await once(activeProcess.stdout!, "data");
    const requestPath = path.join(scratch, "handoff-request.json");
    writeFileSync(requestPath, JSON.stringify({
      authority: {
        kind: "powershell",
        channel: "stable",
        installRoot,
        executable: activePath
      },
      currentVersion: CURRENT,
      targetVersion: NEXT,
      channel: "beta",
      updateChannel: true,
      candidatePath,
      candidateSha256: createHash("sha256")
        .update(readFileSync(candidatePath))
        .digest("hex"),
      workRoot
    }));
    const starterPath = path.join(scratch, "start-handoff.ts");
    const handoffModule = pathToFileURL(fileURLToPath(
      new URL("../src/windows-upgrade-handoff.ts", import.meta.url)
    )).href;
    writeFileSync(starterPath, `import { readFileSync } from "node:fs";
import { startWindowsUpgradeHandoff } from ${JSON.stringify(handoffModule)};
const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
await startWindowsUpgradeHandoff(request);
process.stdout.write(String(process.pid));
`);

    const starterPid = Number(execFileSync(process.execPath, [starterPath, requestPath], {
      encoding: "utf8",
      timeout: 10_000
    }));
    expect(Number.isSafeInteger(starterPid)).toBe(true);
    expect(starterPid).not.toBe(process.pid);

    await waitForHandoffAttempt(workRoot);
    expect(activeProcess.exitCode).toBe(null);
    expect(readFileSync(activePath).equals(currentBytes)).toBe(true);
    expect(JSON.parse(readFileSync(ownershipPath, "utf8"))).toMatchObject({
      channel: "stable"
    });

    const activeClose = once(activeProcess, "close");
    expect(activeProcess.kill()).toBe(true);
    await activeClose;
    activeProcess = undefined;

    await waitForHandoff(activePath, ownershipPath, workRoot, starterPid);
    expect((await readReleaseExecutableIdentity(activePath)).productVersion).toBe(NEXT);
    expect(JSON.parse(readFileSync(ownershipPath, "utf8"))).toMatchObject({
      channel: "beta",
      executable: activePath
    });
  } finally {
    if (activeProcess?.exitCode === null) {
      const activeClose = once(activeProcess, "close");
      activeProcess.kill();
      await activeClose;
    }
    await removeWindowsHandoffScratch(scratch);
  }
}, 75_000);

async function waitForHandoffAttempt(workRoot: string): Promise<void> {
  const transactionPath = path.join(workRoot, "transaction.json");
  const errorPath = path.join(workRoot, "error.txt");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(transactionPath)) return;
    if (existsSync(errorPath)) {
      throw new Error(readFileSync(errorPath, "utf8").trim());
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Windows handoff did not reach the replacement attempt");
}

async function waitForHandoff(
  activePath: string,
  ownershipPath: string,
  workRoot: string,
  starterPid: number
): Promise<void> {
  const deadline = Date.now() + 65_000;
  let lastFailure = "handoff did not start";
  while (Date.now() < deadline) {
    try {
      const ownership = JSON.parse(readFileSync(ownershipPath, "utf8")) as {
        channel?: unknown;
      };
      if (ownership.channel === "beta") {
        const identity = await readReleaseExecutableIdentity(activePath, { timeoutMs: 2_000 });
        if (identity.productVersion === NEXT && !existsSync(workRoot)) return;
        lastFailure = `active=${identity.productVersion}, channel=beta`;
      } else {
        lastFailure = `channel=${String(ownership.channel)}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  const errorPath = path.join(workRoot, "error.txt");
  const helperFailure = existsSync(errorPath)
    ? readFileSync(errorPath, "utf8").trim()
    : "no helper error file";
  throw new Error(
    `Windows handoff from exited PID ${starterPid} timed out: ${lastFailure}; ${helperFailure}`
  );
}
