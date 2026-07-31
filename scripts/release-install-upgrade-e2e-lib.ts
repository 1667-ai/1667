import { chmod, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { releaseTargetForRuntime } from "../shared/release-targets.js";
import { INSTALL_PREVIOUS_FILE } from "../shared/install-layout.js";
import { INSTALL_ACTIVE_EXECUTABLE } from "../shared/install-ownership-record.js";
import {
  execProcess,
  fetchBytes,
  type InstallUpgradeE2eOptions
} from "./release-install-upgrade-e2e-process.js";
import {
  assertEnvelope,
  executeInstaller,
  GITHUB_RELEASE_SIGNER,
  installIntoPrefix,
  logStepPass,
  NPM_RELEASE_SIGNER,
  parseJsonOutput,
  probeIdentity,
  runUpgrade,
  StepError,
  verifyAttestation,
  verifyOwnershipRecord,
  withUnchangedBytes,
  type IdentityExpectation
} from "./release-install-upgrade-e2e-verify.js";

const NPM_REGISTRY = "https://registry.npmjs.org/";

export async function runInstallUpgradeE2e(
  args: InstallUpgradeE2eOptions,
  scratchRoot: string,
  repoRoot: string
): Promise<void> {
  const currentVersion = packageJson.version;
  const runtimeTarget = releaseTargetForRuntime(process.platform, process.arch);
  if (runtimeTarget === null || runtimeTarget.heldFromPublication !== null) {
    throw new Error("Host OS/architecture is not a supported published release target.");
  }
  const hostTarget = runtimeTarget.artifactTarget;
  const currentIdentity: IdentityExpectation = {
    version: currentVersion,
    artifactTarget: hostTarget
  };
  const previousIdentity: IdentityExpectation = {
    version: args.fromVersion,
    artifactTarget: hostTarget
  };

  // Step 1: Download & attest current installer
  const homepageBytes = await fetchBytes(args.homepageUrl);
  const currentBytes = await fetchBytes(args.currentUrl);

  if (!homepageBytes.equals(currentBytes)) {
    throw new StepError(1, "Homepage installer bytes do not match canonical GitHub release installer bytes.");
  }

  const currentScriptPath = path.join(scratchRoot, "install-current.sh");
  await writeFile(currentScriptPath, currentBytes, { mode: 0o755 });

  const shCheck = await execProcess("sh", ["-n", currentScriptPath]);
  if (shCheck.exitCode !== 0) {
    throw new StepError(1, `Shell syntax check failed for current installer:\n${shCheck.stderr}`);
  }

  await verifyAttestation(currentScriptPath, [NPM_RELEASE_SIGNER], 1, "current installer");

  logStepPass(1, "Homepage current installer matches canonical GitHub asset and attestation");

  // Step 2: Homepage installer execution into private prefix
  const current = await installIntoPrefix({
    scratchRoot,
    directoryName: "prefix-current",
    script: homepageBytes,
    expected: currentIdentity,
    channel: "stable",
    stepNum: 2,
    label: "Homepage installation"
  });

  logStepPass(2, "Homepage installer execution into private prefix installs current release");

  // Step 3: Upgrade check up-to-date
  const currentUpToDate = {
    status: "up-to-date",
    method: "shell",
    current: currentVersion,
    latest: currentVersion,
    target: null,
    channel: "stable"
  };
  assertEnvelope(
    await runUpgrade(current.executable, ["--check", "--channel", "stable"], 3, "upgrade --check"),
    currentUpToDate,
    3,
    "upgrade --check"
  );
  assertEnvelope(
    await runUpgrade(current.executable, ["--channel", "stable"], 3, "upgrade apply"),
    currentUpToDate,
    3,
    "upgrade apply"
  );

  logStepPass(3, "Current managed install upgrade check reports up-to-date");

  // Step 4: Re-running homepage installer into same prefix must refuse
  await withUnchangedBytes(
    current.executable,
    4,
    "Re-running homepage installer modified active executable bytes.",
    async () => {
      const reinstall = await executeInstaller(homepageBytes, current.prefix);
      if (reinstall.exitCode === 0) {
        throw new StepError(
          4,
          "Re-running homepage installer into existing prefix unexpectedly succeeded; expected refusal."
        );
      }
      const failureOutput = reinstall.stderr + reinstall.stdout;
      if (!/existing 1667/i.test(failureOutput) || !/1667 upgrade/i.test(failureOutput)) {
        throw new StepError(
          4,
          `Installer refusal output did not identify existing binary and direct user to 1667 upgrade:\n${failureOutput}`
        );
      }
    }
  );

  logStepPass(4, "Re-running homepage installer into existing prefix refuses managed binary");

  // Step 5: Rollback with no previous executable fails safely with valid JSON error envelope
  await withUnchangedBytes(
    current.executable,
    5,
    "Rollback without previous binary modified active executable bytes.",
    async () => {
      const rollback = await execProcess(current.executable, ["upgrade", "--rollback", "--json"]);
      if (rollback.exitCode === 0) {
        throw new StepError(
          5,
          "Rollback with no previous executable unexpectedly succeeded; expected non-zero exit code."
        );
      }
      const env = parseJsonOutput(rollback, 5, "Rollback failure");
      assertEnvelope(env, { status: "error", method: "shell", target: null }, 5, "Rollback failure");
      const error = env.error as Record<string, unknown>;
      if (error.code !== "unsupported_target") {
        throw new StepError(
          5,
          `Rollback error code is '${String(error.code)}', expected 'unsupported_target'.`
        );
      }
      if (typeof error.message !== "string" || !/previous executable/i.test(error.message)) {
        throw new StepError(
          5,
          `Rollback error message does not mention previous executable: '${String(error.message)}'.`
        );
      }
    }
  );

  logStepPass(5, "Managed rollback without previous binary fails safely without modifying active bytes");

  // Step 6: Download/attest previous installer and execute into second prefix
  const previousBytes = await fetchBytes(args.previousUrl);
  const previousScriptPath = path.join(scratchRoot, "install-previous.sh");
  await writeFile(previousScriptPath, previousBytes, { mode: 0o755 });

  const prevShCheck = await execProcess("sh", ["-n", previousScriptPath]);
  if (prevShCheck.exitCode !== 0) {
    throw new StepError(6, `Shell syntax check failed for previous installer:\n${prevShCheck.stderr}`);
  }

  const previousSigners = args.fromChannel === "beta"
    ? [NPM_RELEASE_SIGNER, GITHUB_RELEASE_SIGNER]
    : [NPM_RELEASE_SIGNER];
  await verifyAttestation(previousScriptPath, previousSigners, 6, "previous installer");

  const previous = await installIntoPrefix({
    scratchRoot,
    directoryName: "prefix-previous",
    script: previousBytes,
    expected: previousIdentity,
    channel: args.fromChannel,
    stepNum: 6,
    label: "Previous installation"
  });

  logStepPass(6, "Downloaded previous installer executes into second prefix");

  // Step 7: Copied executable to root with no Ownership Record
  const copiedPrefixRaw = path.join(scratchRoot, "prefix-copied");
  await mkdir(copiedPrefixRaw, { mode: 0o755 });
  const copiedPrefix = await realpath(copiedPrefixRaw);
  const copiedExecutable = path.join(copiedPrefix, INSTALL_ACTIVE_EXECUTABLE);
  await copyFile(previous.executable, copiedExecutable);
  await chmod(copiedExecutable, 0o755);

  await withUnchangedBytes(
    copiedExecutable,
    7,
    "Copied executable upgrade attempt modified executable bytes.",
    async () => {
      assertEnvelope(
        await runUpgrade(copiedExecutable, ["--channel", "stable"], 7, "Copied executable upgrade"),
        { status: "manual", method: "manual", target: currentVersion },
        7,
        "Copied executable upgrade"
      );
    }
  );

  logStepPass(7, "Executable copied to root without ownership record reports manual upgrade method");

  // Step 8: Managed previous install upgrades, rolls back, re-upgrades, channel switch
  assertEnvelope(
    await runUpgrade(
      previous.executable,
      ["--check", "--channel", "stable"],
      8,
      "Managed previous upgrade check"
    ),
    {
      status: "available",
      method: "shell",
      current: args.fromVersion,
      target: currentVersion,
      channel: "stable"
    },
    8,
    "Managed previous upgrade check"
  );

  const previousBytesBeforeUpgrade = await readFile(previous.executable);

  // 8b: exact-upgrade
  assertEnvelope(
    await runUpgrade(
      previous.executable,
      ["--version", currentVersion, "--channel", "stable"],
      8,
      `Managed upgrade to ${currentVersion}`
    ),
    {
      status: "applied",
      method: "shell",
      current: args.fromVersion,
      target: currentVersion,
      channel: "stable"
    },
    8,
    "Managed exact-upgrade"
  );
  await probeIdentity(previous.executable, currentIdentity, 8, "Upgraded executable");
  const currentBytesAfterUpgrade = await readFile(previous.executable);
  const retainedPreviousBytes = await readFile(path.join(previous.prefix, INSTALL_PREVIOUS_FILE));
  if (!retainedPreviousBytes.equals(previousBytesBeforeUpgrade)) {
    throw new StepError(
      8,
      `${INSTALL_PREVIOUS_FILE} bytes do not match original previous executable bytes.`
    );
  }

  // 8c: rollback restores the original bytes, not merely the original version
  assertEnvelope(
    await runUpgrade(previous.executable, ["--rollback"], 8, "Managed rollback"),
    { status: "applied", method: "shell", current: currentVersion, target: args.fromVersion },
    8,
    "Managed rollback"
  );
  await probeIdentity(previous.executable, previousIdentity, 8, "Rolled back executable");
  if (!(await readFile(previous.executable)).equals(previousBytesBeforeUpgrade)) {
    throw new StepError(
      8,
      "Rollback restored a version that does not match the original executable bytes."
    );
  }

  // 8d: stable re-upgrade
  assertEnvelope(
    await runUpgrade(previous.executable, ["--channel", "stable"], 8, "Re-upgrade"),
    {
      status: "applied",
      method: "shell",
      current: args.fromVersion,
      target: currentVersion,
      channel: "stable"
    },
    8,
    "Managed re-upgrade"
  );
  await probeIdentity(previous.executable, currentIdentity, 8, "Re-upgraded executable");
  if (!(await readFile(previous.executable)).equals(currentBytesAfterUpgrade)) {
    throw new StepError(8, "Re-upgrade produced executable bytes that differ from the first upgrade.");
  }

  // 8e: stable no-op
  assertEnvelope(
    await runUpgrade(previous.executable, ["--channel", "stable"], 8, "Repeated stable upgrade"),
    {
      status: "up-to-date",
      method: "shell",
      current: currentVersion,
      target: null,
      channel: "stable"
    },
    8,
    "Repeated stable upgrade"
  );

  // 8f: beta switch. The beta channel legitimately runs ahead of stable, so the
  // gate asks what beta offers instead of assuming beta still equals stable.
  const betaPlan = await runUpgrade(
    previous.executable,
    ["--check", "--channel", "beta"],
    8,
    "Beta channel check"
  );
  const betaHead = betaPlan.latest;
  if (typeof betaHead !== "string") {
    throw new StepError(
      8,
      `Beta channel check reported latest ${JSON.stringify(betaHead)}, expected a version.`
    );
  }
  const betaIsNewer = betaHead !== currentVersion;
  const betaExpectation = {
    method: "shell",
    current: currentVersion,
    latest: betaHead,
    target: betaIsNewer ? betaHead : null,
    channel: "beta"
  };
  assertEnvelope(
    betaPlan,
    { ...betaExpectation, status: betaIsNewer ? "available" : "up-to-date" },
    8,
    "Beta channel check"
  );
  assertEnvelope(
    await runUpgrade(previous.executable, ["--channel", "beta"], 8, "Channel switch to beta"),
    { ...betaExpectation, status: betaIsNewer ? "applied" : "up-to-date" },
    8,
    "Channel switch to beta"
  );
  await probeIdentity(
    previous.executable,
    { version: betaIsNewer ? betaHead : currentVersion, artifactTarget: hostTarget },
    8,
    "Executable after beta channel switch"
  );
  if (!betaIsNewer && !(await readFile(previous.executable)).equals(currentBytesAfterUpgrade)) {
    throw new StepError(
      8,
      "Channel switch modified active executable bytes with no newer beta release."
    );
  }
  await verifyOwnershipRecord(previous.prefix, "beta", 8, "Channel switch");

  logStepPass(8, "Managed previous install upgrades, rolls back, re-upgrades, and switches channel");

  // Step 9: npm external lane
  const npmScratch = path.join(scratchRoot, "npm-lane");
  await mkdir(npmScratch, { mode: 0o755 });
  // npm finds the local prefix by walking up from the working directory to the
  // first directory that holds a package.json or a node_modules directory. That
  // walk reaches the operator home directory when this file is absent, and npm
  // then installs there instead of inside the scratch directory.
  await writeFile(
    path.join(npmScratch, "package.json"),
    `${JSON.stringify({ name: "release-e2e-npm-lane", version: "0.0.0", private: true }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const npmInstall = await execProcess(
    "npm",
    [
      "install",
      `@1667-ai/cli@${currentVersion}`,
      `--registry=${NPM_REGISTRY}`,
      `--@1667-ai:registry=${NPM_REGISTRY}`,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund"
    ],
    {
      cwd: npmScratch,
      env: {
        ...process.env,
        npm_config_prefix: path.join(npmScratch, "npm-prefix"),
        // npm writes its cache and logs outside the scratch tree otherwise, and
        // those files survive the scratch cleanup.
        npm_config_cache: path.join(npmScratch, "npm-cache")
      }
    }
  );
  if (npmInstall.exitCode !== 0) {
    throw new StepError(9, `npm install @1667-ai/cli@${currentVersion} failed:\n${npmInstall.stderr}`);
  }

  const npmBin = path.join(npmScratch, "node_modules", ".bin", INSTALL_ACTIVE_EXECUTABLE);
  await probeIdentity(npmBin, currentIdentity, 9, "npm binary");

  const npmExternal = {
    status: "up-to-date",
    method: "manual",
    current: currentVersion,
    target: null,
    channel: "stable"
  };
  assertEnvelope(
    await runUpgrade(npmBin, ["--check", "--channel", "stable"], 9, "npm external lane check"),
    npmExternal,
    9,
    "npm external lane check"
  );

  const npmPlatformBin = path.join(
    npmScratch,
    "node_modules",
    runtimeTarget.packageName,
    runtimeTarget.executable
  );
  await withUnchangedBytes(
    npmPlatformBin,
    9,
    "npm external lane upgrade modified the platform executable.",
    async () => {
      assertEnvelope(
        await runUpgrade(npmBin, ["--channel", "stable"], 9, "npm external lane apply"),
        npmExternal,
        9,
        "npm external lane apply"
      );
    }
  );

  logStepPass(9, "npm external lane check and apply stay externally managed");

  // Step 10: source external lane. Under Bun the installation authority resolves
  // from `process.execPath`, which is the Bun executable rather than the entry
  // script, so the Bun executable is the file an apply could replace.
  const bunProbe = await execProcess(
    "bun",
    ["-e", "process.stdout.write(process.execPath)"],
    { cwd: repoRoot }
  );
  if (bunProbe.exitCode !== 0) {
    throw new StepError(10, `Could not resolve the Bun executable path:\n${bunProbe.stderr}`);
  }
  const bunExecutable = bunProbe.stdout.trim();
  if (bunExecutable.length === 0) {
    throw new StepError(10, "Bun reported an empty executable path.");
  }

  const sourceEntry = path.join("tui", "src", "standalone.ts");
  const runSource = async (upgradeArgs: readonly string[], label: string) => {
    const result = await execProcess(
      "bun",
      [sourceEntry, "upgrade", ...upgradeArgs, "--json"],
      { cwd: repoRoot }
    );
    if (result.exitCode !== 0) {
      throw new StepError(10, `source checkout ${label} failed:\n${result.stderr || result.stdout}`);
    }
    return parseJsonOutput(result, 10, label);
  };

  const sourceExternal = {
    status: "up-to-date",
    method: "manual",
    current: currentVersion,
    target: null,
    channel: "stable"
  };
  assertEnvelope(
    await runSource(["--check", "--channel", "stable"], "Source external lane check"),
    sourceExternal,
    10,
    "Source external lane check"
  );

  await withUnchangedBytes(
    bunExecutable,
    10,
    "Source external lane upgrade modified the Bun executable.",
    async () => {
      assertEnvelope(
        await runSource(["--channel", "stable"], "Source external lane apply"),
        sourceExternal,
        10,
        "Source external lane apply"
      );
    }
  );

  logStepPass(10, "Source external lane check and apply stay externally managed");

  process.stdout.write("\nSUMMARY: All 10 end-to-end release gate verification steps passed.\n");
}
