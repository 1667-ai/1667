import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { serializeInstallOwnershipRecord } from "../../shared/install-ownership-record.js";
import {
  acquireInstallationLock,
  activateCandidate,
  copyExclusive,
  recoverInstallationTransaction,
  writeTransactionRecord
} from "../src/install-transaction.js";
import { applyUpgrade } from "../src/upgrade-apply.js";
import { UpgradeFailure } from "../src/upgrade-contract.js";
import {
  TXN_TEST_CURRENT as CURRENT,
  TXN_TEST_NEXT as NEXT,
  TXN_TEST_OLDER as OLDER,
  TXN_TEST_PACKAGE as PACKAGE,
  managedTxn,
  shellTxnAuthority,
  txnScratchRoot,
  writeTxnStub
} from "./install-transaction-test-fixture.js";

test("upgrade preserves old previous until activation; recovery finishes interrupted rename", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.previous, OLDER);

    // Simulate candidate-ready after atomic rename: active is NEXT, previousNext is CURRENT,
    // existing previous is still OLDER.
    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previousNext, CURRENT);
    writeTxnStub(paths.candidate, "junk");
    writeTransactionRecord(paths, managedTxn("candidate-ready", record, CURRENT, NEXT));

    const lock = await acquireInstallationLock(installRoot);
    try {
      const outcome = await recoverInstallationTransaction(authority, lock.paths);
      expect(outcome).toMatchObject({
        kind: "completed",
        fromVersion: CURRENT,
        toVersion: NEXT
      });
      expect(existsSync(paths.transaction)).toBe(false);
      expect(existsSync(paths.previousNext)).toBe(false);
      expect(existsSync(paths.candidate)).toBe(false);
      // Existing previous was replaced by previousNext only after recovery completed.
      expect(readFileSync(paths.previous, "utf8")).toContain(CURRENT);
      expect(readFileSync(paths.active, "utf8")).toContain(NEXT);
    } finally {
      await lock.release();
    }

    // Recovery-completed path: applyUpgrade must not run a second mutation or
    // touch the registry/network.
    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previousNext, CURRENT);
    writeTxnStub(paths.previous, OLDER);
    writeTransactionRecord(paths, managedTxn("candidate-ready", record, CURRENT, NEXT));
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });

    let fetchCount = 0;
    let registryCalls = 0;
    const result = await applyUpgrade({ kind: "apply", version: null, channel: "beta" }, {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: {
        async channelHead() {
          registryCalls += 1;
          throw new Error("registry must not be used after completed recovery");
        },
        async launcher() {
          registryCalls += 1;
          throw new Error("registry must not be used after completed recovery");
        },
        async platform() {
          registryCalls += 1;
          throw new Error("registry must not be used after completed recovery");
        }
      },
      fetcher: async () => {
        fetchCount += 1;
        throw new Error("network must not be used after completed recovery");
      }
    });
    expect(result).toMatchObject({
      status: "applied",
      current: CURRENT,
      target: NEXT,
      latest: NEXT
    });
    expect(fetchCount).toBe(0);
    expect(registryCalls).toBe(0);
    expect(readFileSync(paths.active, "utf8")).toContain(NEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate-ready with old active aborts staging and keeps previous", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.active, CURRENT);
    writeTxnStub(paths.previous, OLDER);
    writeTxnStub(paths.previousNext, CURRENT);
    writeTxnStub(paths.candidate, NEXT);
    writeTransactionRecord(paths, managedTxn("candidate-ready", record, CURRENT, NEXT));
    const lock = await acquireInstallationLock(installRoot);
    try {
      const outcome = await recoverInstallationTransaction(authority, lock.paths);
      expect(outcome.kind).toBe("clean");
      expect(existsSync(paths.candidate)).toBe(false);
      expect(existsSync(paths.previousNext)).toBe(false);
      expect(readFileSync(paths.active, "utf8")).toContain(CURRENT);
      expect(readFileSync(paths.previous, "utf8")).toContain(OLDER);
    } finally {
      await lock.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ownership-pending recovery fails closed without verified rollback", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.active, NEXT);
    // No previousNext and no previous: fail closed before ownership write.
    writeTransactionRecord(paths, managedTxn("ownership-pending", record, CURRENT, NEXT));
    const lock = await acquireInstallationLock(installRoot);
    try {
      let failed = false;
      try {
        await recoverInstallationTransaction(authority, lock.paths);
      } catch (error) {
        failed = true;
        expect(String(error)).toMatch(/verified rollback executable/);
      }
      expect(failed).toBe(true);
      expect(existsSync(paths.transaction)).toBe(true);
      expect(JSON.parse(readFileSync(paths.ownership, "utf8")).channel).toBe("beta");
    } finally {
      await lock.release();
    }

    // Wrong-version previous also fails closed; transaction stays.
    writeTxnStub(paths.previous, OLDER);
    const lock2 = await acquireInstallationLock(installRoot);
    try {
      let failed = false;
      try {
        await recoverInstallationTransaction(authority, lock2.paths);
      } catch (error) {
        failed = true;
        expect(String(error)).toMatch(/version|probe|identity|rollback/i);
      }
      expect(failed).toBe(true);
      expect(existsSync(paths.transaction)).toBe(true);
    } finally {
      await lock2.release();
    }

    // previousNext matching activeVersion allows completion.
    writeTxnStub(paths.previousNext, CURRENT);
    const lock3 = await acquireInstallationLock(installRoot);
    try {
      const outcome = await recoverInstallationTransaction(authority, lock3.paths);
      expect(outcome).toMatchObject({
        kind: "completed",
        fromVersion: CURRENT,
        toVersion: NEXT
      });
      expect(existsSync(paths.transaction)).toBe(false);
      expect(readFileSync(paths.previous, "utf8")).toContain(CURRENT);
    } finally {
      await lock3.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activateCandidate aborts before commit without replacing active or publishing txn", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.candidate, NEXT);
    writeTxnStub(paths.previous, OLDER);
    const activeBefore = readFileSync(paths.active, "utf8");

    const controller = new AbortController();
    controller.abort();
    let failed: unknown;
    try {
      await activateCandidate({
        authority,
        paths,
        operation: "upgrade",
        activeVersion: CURRENT,
        candidateVersion: NEXT,
        channel: "beta",
        updateChannel: true,
        signal: controller.signal
      });
    } catch (error) {
      failed = error;
    }
    expect(failed instanceof UpgradeFailure).toBe(true);
    expect((failed as UpgradeFailure).code).toBe("interrupted");
    expect(existsSync(paths.transaction)).toBe(false);
    expect(existsSync(paths.previousNext)).toBe(false);
    expect(readFileSync(paths.active, "utf8")).toBe(activeBefore);
    expect(existsSync(paths.candidate)).toBe(true);
    expect(readFileSync(paths.previous, "utf8")).toContain(OLDER);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copyExclusive cancellation cleans partial destination and reports interruption", async () => {
  const root = txnScratchRoot();
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "dest");
    // Large enough that mid-copy abort can race the stream; abort before start also covers cleanup.
    writeFileSync(source, "x".repeat(256 * 1024), { mode: 0o755 });
    chmodSync(source, 0o755);
    const controller = new AbortController();
    const pending = copyExclusive(source, destination, 0o755, controller.signal);
    controller.abort();
    let failed: unknown;
    try {
      await pending;
    } catch (error) {
      failed = error;
    }
    expect(failed instanceof UpgradeFailure).toBe(true);
    expect((failed as UpgradeFailure).code).toBe("interrupted");
    expect(existsSync(destination)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activateCandidate mid-copy abort cleans previousNext and keeps active", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths } = shellTxnAuthority(installRoot, "beta");
    // Oversized active forces a multi-chunk exclusive copy of previousNext.
    writeFileSync(paths.active, "A".repeat(512 * 1024), { mode: 0o755 });
    chmodSync(paths.active, 0o755);
    writeTxnStub(paths.candidate, NEXT);
    writeTxnStub(paths.previous, OLDER);
    const activeBefore = readFileSync(paths.active);

    const controller = new AbortController();
    const pending = activateCandidate({
      authority,
      paths,
      operation: "upgrade",
      activeVersion: CURRENT,
      candidateVersion: NEXT,
      channel: "beta",
      updateChannel: false,
      signal: controller.signal
    });
    controller.abort();
    let failed: unknown;
    try {
      await pending;
    } catch (error) {
      failed = error;
    }
    expect(failed instanceof UpgradeFailure).toBe(true);
    expect((failed as UpgradeFailure).code).toBe("interrupted");
    expect(existsSync(paths.transaction)).toBe(false);
    expect(existsSync(paths.previousNext)).toBe(false);
    expect(readFileSync(paths.active)).toEqual(activeBefore);
    expect(existsSync(paths.candidate)).toBe(true);
    expect(readFileSync(paths.previous, "utf8")).toContain(OLDER);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
