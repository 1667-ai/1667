import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { recoverInstallationTransaction } from "../src/install-transaction.js";
import {
  TXN_TEST_CURRENT as CURRENT,
  TXN_TEST_NEXT as NEXT,
  TXN_TEST_TARGET as TARGET,
  shellTxnAuthority,
  txnScratchRoot,
  writeTxnStub
} from "./install-transaction-test-fixture.js";

test("Shell Installer activated txn is cleared; wrong phase and mismatch are rejected", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.active, CURRENT);
    const digest = "a".repeat(64);
    const goodInstallerTxn = {
      kind: "shell-installer" as const,
      schemaVersion: 1 as const,
      phase: "activated" as const,
      version: CURRENT,
      channel: "beta" as const,
      artifactTarget: TARGET,
      archiveSha256: digest,
      installRoot,
      executable: paths.active
    };
    writeFileSync(paths.transaction, `${JSON.stringify(goodInstallerTxn)}\n`, { mode: 0o600 });

    const outcome = await recoverInstallationTransaction(authority, paths);
    expect(outcome).toEqual({ kind: "shell-installer-finalized" });
    expect(existsSync(paths.transaction)).toBe(false);

    writeFileSync(
      paths.transaction,
      `${JSON.stringify({ ...goodInstallerTxn, phase: "downloading" })}\n`,
      { mode: 0o600 }
    );
    let phaseRejected = false;
    try {
      await recoverInstallationTransaction(authority, paths);
    } catch (error) {
      phaseRejected = /not activated|phase/i.test(String(error));
    }
    expect(phaseRejected).toBe(true);
    expect(existsSync(paths.transaction)).toBe(true);

    writeFileSync(
      paths.transaction,
      `${JSON.stringify({ ...goodInstallerTxn, channel: "stable" })}\n`,
      { mode: 0o600 }
    );
    let channelRejected = false;
    try {
      await recoverInstallationTransaction(authority, paths);
    } catch (error) {
      channelRejected = /does not match the Ownership Record/i.test(String(error));
    }
    expect(channelRejected).toBe(true);

    writeTxnStub(paths.active, NEXT);
    writeFileSync(
      paths.transaction,
      `${JSON.stringify(goodInstallerTxn)}\n`,
      { mode: 0o600 }
    );
    let versionRejected = false;
    try {
      await recoverInstallationTransaction(authority, paths);
    } catch (error) {
      versionRejected = /does not match the active executable/i.test(String(error));
    }
    expect(versionRejected).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
