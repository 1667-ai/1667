import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ExecutableProbeError } from "../../shared/executable-probe.js";
import {
  createInstallOwnershipRecord,
  serializeInstallOwnershipRecord
} from "../../shared/install-ownership-record.js";
import type { PublishedPlatformPackage } from "../../shared/release-targets.js";
import { releaseTargetForArtifact } from "../../shared/release-targets.js";
import { managedInstallPaths } from "../src/install-layout.js";
import { writeTransactionRecord } from "../src/install-transaction.js";
import { UpgradeFailure } from "../src/upgrade-contract.js";
import { executeUpgradeCli } from "../src/upgrade-cli.js";
import { probeCandidateVersion } from "../src/upgrade-candidate.js";
import { throwUpgradeProbeFailure } from "../src/upgrade-probe-errors.js";
import {
  TXN_TEST_CURRENT as CURRENT,
  TXN_TEST_NEXT as NEXT,
  managedTxn
} from "./install-transaction-test-fixture.js";

const TARGET = "darwin-arm64" as const;
const PACKAGE = releaseTargetForArtifact(TARGET).packageName as PublishedPlatformPackage;

function probeScratch(): string {
  const base = path.join(homedir(), ".cache", "1667-tests");
  mkdirSync(base, { recursive: true, mode: 0o755 });
  chmodSync(base, 0o755);
  return realpathSync(mkdtempSync(path.join(base, "probe-")));
}

function hangVersionStub(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ] && [ "$2" = "--json" ]; then
  sleep 60
fi
exit 1
`;
}

test("throwUpgradeProbeFailure uses AbortSignal.aborted only for ExecutableProbeError", () => {
  const aborted = AbortSignal.abort();
  const live = new AbortController().signal;
  try {
    throwUpgradeProbeFailure(
      new ExecutableProbeError("Executable identity did not match"),
      aborted
    );
    expect(true).toBe(false);
  } catch (error) {
    expect(error instanceof UpgradeFailure).toBe(true);
    expect((error as UpgradeFailure).code).toBe("interrupted");
  }
  try {
    throwUpgradeProbeFailure(
      new ExecutableProbeError("Executable probe was interrupted"),
      live
    );
    expect(true).toBe(false);
  } catch (error) {
    // Live signal: message text alone must not force interrupted.
    expect(error instanceof UpgradeFailure).toBe(true);
    expect((error as UpgradeFailure).code).toBe("verification_failed");
  }
  // Generic errors are never translated, even when the signal is aborted.
  const diskError = new Error("EIO: disk failure under lock");
  try {
    throwUpgradeProbeFailure(diskError, aborted);
    expect(true).toBe(false);
  } catch (error) {
    expect(error).toBe(diskError);
    expect(error instanceof UpgradeFailure).toBe(false);
  }
});

test("candidate probe cancellation becomes interrupted UpgradeFailure", async () => {
  const root = probeScratch();
  try {
    const exe = path.join(root, "1667");
    writeFileSync(exe, hangVersionStub(), { mode: 0o755 });
    chmodSync(exe, 0o755);
    const controller = new AbortController();
    const probe = probeCandidateVersion(exe, "1.0.0", TARGET, controller.signal);
    controller.abort();
    let code: string | null = null;
    try {
      await probe;
    } catch (error) {
      code = error instanceof UpgradeFailure ? error.code : null;
    }
    expect(code).toBe("interrupted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeUpgradeCli maps active probe interrupt to exit 130 JSON envelope", async () => {
  const root = probeScratch();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const paths = managedInstallPaths(installRoot);
    writeFileSync(paths.active, hangVersionStub(), { mode: 0o755 });
    chmodSync(paths.active, 0o755);
    const record = createInstallOwnershipRecord({
      installationId: randomBytes(16).toString("hex"),
      channel: "beta",
      installRoot,
      executable: paths.active,
      artifactTarget: TARGET
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    chmodSync(paths.ownership, 0o600);

    const controller = new AbortController();
    const run = executeUpgradeCli(["--json", "--channel", "beta"], {
      authority: {
        kind: "shell",
        record,
        installRoot,
        executable: paths.active
      },
      observation: {
        currentVersion: "1.0.0",
        platformPackage: PACKAGE,
        },
      registry: {
        async channelHead() { return "1.1.0"; },
        async launcher() {
          return {
            name: "@1667-ai/cli",
            version: "1.1.0",
            integrity: "sha512-" + "A".repeat(86) + "==",
            tarball: "https://example.invalid/x.tgz"
          };
        },
        async platform() {
          return {
            name: PACKAGE,
            version: "1.1.0",
            integrity: "sha512-" + "A".repeat(86) + "==",
            tarball: "https://example.invalid/x.tgz"
          };
        }
      },
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    const result = await run;
    expect(result.exitCode).toBe(130);
    expect(result.envelope).toMatchObject({
      status: "error",
      error: { code: "interrupted" }
    });
    expect(result.stdout.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeUpgradeCli recovery probe cancel is exit 130 with one JSON envelope", async () => {
  // Real ownership-pending txn forces recovery to probe active (hangs); abort mid-probe.
  const root = probeScratch();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const paths = managedInstallPaths(installRoot);
    writeFileSync(paths.active, hangVersionStub(), { mode: 0o755 });
    chmodSync(paths.active, 0o755);
    writeFileSync(paths.previous, hangVersionStub(), { mode: 0o755 });
    chmodSync(paths.previous, 0o755);
    const record = createInstallOwnershipRecord({
      installationId: randomBytes(16).toString("hex"),
      channel: "beta",
      installRoot,
      executable: paths.active,
      artifactTarget: TARGET
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    chmodSync(paths.ownership, 0o600);
    writeTransactionRecord(paths, managedTxn(
      "ownership-pending",
      record,
      CURRENT,
      NEXT,
      "upgrade"
    ));

    const controller = new AbortController();
    const run = executeUpgradeCli(["--json", "--channel", "beta"], {
      authority: {
        kind: "shell",
        record,
        installRoot,
        executable: paths.active
      },
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: {
        async channelHead() {
          throw new Error("registry must not run during recovery probe cancel");
        },
        async launcher() {
          throw new Error("registry must not run during recovery probe cancel");
        },
        async platform() {
          throw new Error("registry must not run during recovery probe cancel");
        }
      },
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 50);
    const result = await run;
    expect(result.exitCode).toBe(130);
    expect(result.envelope).toMatchObject({
      status: "error",
      error: { code: "interrupted" }
    });
    expect(result.stdout.split("\n").filter((line) => line.length > 0)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
