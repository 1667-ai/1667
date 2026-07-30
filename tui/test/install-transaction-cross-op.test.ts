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
import { writeTransactionRecord } from "../src/install-transaction.js";
import { applyRollback, applyUpgrade } from "../src/upgrade-apply.js";
import { buildCanonicalPlatformPackage } from "./managed-package-fixture.js";
import {
  TXN_TEST_CURRENT as CURRENT,
  TXN_TEST_NEXT as NEXT,
  TXN_TEST_PACKAGE as PACKAGE,
  TXN_TEST_TARGET as TARGET,
  managedTxn,
  shellTxnAuthority,
  txnScratchRoot,
  writeTxnStub
} from "./install-transaction-test-fixture.js";

test("interrupted upgrade recovery during rollback finishes upgrade then rolls back", async () => {
  // Ownership starts beta. Interrupted upgrade has updateChannel=true → stable.
  // Recovery must publish stable; the requested rollback must not overwrite beta.
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previous, CURRENT);
    writeTransactionRecord(paths, {
      ...managedTxn("ownership-pending", record, CURRENT, NEXT, "upgrade"),
      updateChannel: true,
      channel: "stable"
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    expect(JSON.parse(readFileSync(paths.ownership, "utf8")).channel).toBe("beta");

    const result = await applyRollback({
      authority,
      observation: {
        currentVersion: NEXT,
        platformPackage: PACKAGE,
        }
    });
    expect(result).toMatchObject({
      status: "applied",
      current: NEXT,
      target: CURRENT,
      latest: CURRENT,
      channel: "stable"
    });
    expect(existsSync(paths.transaction)).toBe(false);
    expect(readFileSync(paths.active, "utf8")).toContain(CURRENT);
    expect(readFileSync(paths.active, "utf8")).not.toContain(NEXT);
    expect(readFileSync(paths.previous, "utf8")).toContain(NEXT);
    expect(readFileSync(paths.previous, "utf8")).not.toContain(CURRENT);
    const ownership = JSON.parse(readFileSync(paths.ownership, "utf8")) as { channel: string };
    expect(ownership.channel).toBe("stable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted rollback recovery during upgrade finishes rollback then upgrades once", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.active, CURRENT);
    writeTxnStub(paths.previous, NEXT);
    writeTransactionRecord(paths, managedTxn("ownership-pending", record, NEXT, CURRENT, "rollback"));
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });

    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    let fetchCount = 0;
    const result = await applyUpgrade({ kind: "apply", version: null, channel: "beta" }, {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: {
        async channelHead() { return NEXT; },
        async launcher(version: string) {
          return { name: "@1667-ai/cli", version, integrity: pkg.integrity, tarball: pkg.tarballUrl };
        },
        async platform(name: string, version: string) {
          return { name, version, integrity: pkg.integrity, tarball: pkg.tarballUrl };
        }
      },
      fetcher: async () => {
        fetchCount += 1;
        return new Response(new Uint8Array(pkg.bytes), { status: 200 });
      }
    });
    expect(result).toMatchObject({
      status: "applied",
      current: CURRENT,
      target: NEXT,
      latest: NEXT
    });
    expect(fetchCount).toBe(1);
    expect(existsSync(paths.transaction)).toBe(false);
    expect(readFileSync(paths.active, "utf8")).toContain(NEXT);
    expect(readFileSync(paths.previous, "utf8")).toContain(CURRENT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact-version beta recovery keeps request channel when Ownership stays stable", async () => {
  // Stable Ownership; interrupted exact-version beta upgrade (updateChannel false).
  // Recovery must still recognize the beta request even though Ownership stays stable.
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellTxnAuthority(installRoot, "stable");
    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previous, CURRENT);
    writeTransactionRecord(paths, {
      ...managedTxn("ownership-pending", record, CURRENT, NEXT, "upgrade"),
      channel: "beta",
      updateChannel: false
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    expect(JSON.parse(readFileSync(paths.ownership, "utf8")).channel).toBe("stable");

    let fetchCount = 0;
    let registryCalls = 0;
    const matched = await applyUpgrade(
      { kind: "apply", version: NEXT, channel: "beta" },
      {
        authority,
        observation: {
          currentVersion: CURRENT,
          platformPackage: PACKAGE,
          },
        registry: {
          async channelHead() {
            registryCalls += 1;
            throw new Error("registry must not run on matching recovery");
          },
          async launcher() {
            registryCalls += 1;
            throw new Error("registry must not run on matching recovery");
          },
          async platform() {
            registryCalls += 1;
            throw new Error("registry must not run on matching recovery");
          }
        },
        fetcher: async () => {
          fetchCount += 1;
          throw new Error("network must not run on matching recovery");
        }
      }
    );
    expect(matched).toMatchObject({
      status: "applied",
      current: CURRENT,
      target: NEXT,
      channel: "beta"
    });
    expect(fetchCount).toBe(0);
    expect(registryCalls).toBe(0);
    expect(existsSync(paths.transaction)).toBe(false);
    // updateChannel false: Ownership Record channel stays stable.
    expect(JSON.parse(readFileSync(paths.ownership, "utf8")).channel).toBe("stable");

    // Same interrupted beta txn again: a stable-channel retry must not early-return
    // as the recovered beta request; normal planning continues (already at target).
    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previous, CURRENT);
    writeTransactionRecord(paths, {
      ...managedTxn("ownership-pending", record, CURRENT, NEXT, "upgrade"),
      channel: "beta",
      updateChannel: false
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    fetchCount = 0;
    registryCalls = 0;
    const stableRetry = await applyUpgrade(
      { kind: "apply", version: NEXT, channel: "stable" },
      {
        authority,
        observation: {
          currentVersion: CURRENT,
          platformPackage: PACKAGE,
          },
        registry: {
          async channelHead() {
            registryCalls += 1;
            return NEXT;
          },
          async launcher(version: string) {
            registryCalls += 1;
            return {
              name: "@1667-ai/cli",
              version,
              integrity: "sha512-" + "A".repeat(86) + "==",
              tarball: "https://example.invalid/x.tgz"
            };
          },
          async platform(name: string, version: string) {
            registryCalls += 1;
            return {
              name,
              version,
              integrity: "sha512-" + "A".repeat(86) + "==",
              tarball: "https://example.invalid/x.tgz"
            };
          }
        },
        fetcher: async () => {
          fetchCount += 1;
          throw new Error("should not download when already at exact target");
        }
      }
    );
    expect(stableRetry).toMatchObject({
      status: "up-to-date",
      current: NEXT,
      target: null,
      channel: "stable"
    });
    // Continued planning (not recovery early-return as "applied").
    expect(stableRetry.status).not.toBe("applied");
    expect(registryCalls).toBe(1);
    expect(fetchCount).toBe(0);
    expect(existsSync(paths.transaction)).toBe(false);
    expect(JSON.parse(readFileSync(paths.ownership, "utf8")).channel).toBe("stable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovered upgrade early-returns only when channel and exact version match request", async () => {
  const root = txnScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellTxnAuthority(installRoot, "beta");
    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previous, CURRENT);
    writeTransactionRecord(paths, {
      ...managedTxn("ownership-pending", record, CURRENT, NEXT, "upgrade"),
      channel: "beta",
      updateChannel: false
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });

    let fetchCount = 0;
    const matched = await applyUpgrade({ kind: "apply", version: null, channel: "beta" }, {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: {
        async channelHead() { throw new Error("registry must not run on matching recovery"); },
        async launcher() { throw new Error("registry must not run on matching recovery"); },
        async platform() { throw new Error("registry must not run on matching recovery"); }
      },
      fetcher: async () => {
        fetchCount += 1;
        throw new Error("network must not run on matching recovery");
      }
    });
    expect(matched).toMatchObject({
      status: "applied",
      current: CURRENT,
      target: NEXT,
      channel: "beta"
    });
    expect(fetchCount).toBe(0);

    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previous, CURRENT);
    writeTransactionRecord(paths, {
      ...managedTxn("ownership-pending", record, CURRENT, NEXT, "upgrade"),
      channel: "beta",
      updateChannel: false
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    fetchCount = 0;
    const channelMismatch = await applyUpgrade(
      { kind: "apply", version: null, channel: "stable" },
      {
        authority,
        observation: {
          currentVersion: CURRENT,
          platformPackage: PACKAGE,
          },
        registry: {
          async channelHead() { return NEXT; },
          async launcher(version: string) {
            return {
              name: "@1667-ai/cli",
              version,
              integrity: "sha512-" + "A".repeat(86) + "==",
              tarball: "https://example.invalid/x.tgz"
            };
          },
          async platform(name: string, version: string) {
            return {
              name,
              version,
              integrity: "sha512-" + "A".repeat(86) + "==",
              tarball: "https://example.invalid/x.tgz"
            };
          }
        },
        fetcher: async () => {
          fetchCount += 1;
          throw new Error("should not download when already at head");
        }
      }
    );
    expect(channelMismatch).toMatchObject({
      status: "up-to-date",
      current: NEXT,
      target: null,
      channel: "stable"
    });
    expect(fetchCount).toBe(0);
    expect(existsSync(paths.transaction)).toBe(false);

    const newer = "1.2.0";
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: newer,
      target: TARGET
    });
    writeTxnStub(paths.active, NEXT);
    writeTxnStub(paths.previous, CURRENT);
    writeTransactionRecord(paths, {
      ...managedTxn("ownership-pending", record, CURRENT, NEXT, "upgrade"),
      channel: "beta",
      updateChannel: false
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    fetchCount = 0;
    const versionMismatch = await applyUpgrade(
      { kind: "apply", version: newer, channel: "beta" },
      {
        authority,
        observation: {
          currentVersion: CURRENT,
          platformPackage: PACKAGE,
          },
        registry: {
          async channelHead() { return newer; },
          async launcher(version: string) {
            return { name: "@1667-ai/cli", version, integrity: pkg.integrity, tarball: pkg.tarballUrl };
          },
          async platform(name: string, version: string) {
            return { name, version, integrity: pkg.integrity, tarball: pkg.tarballUrl };
          }
        },
        fetcher: async () => {
          fetchCount += 1;
          return new Response(new Uint8Array(pkg.bytes), { status: 200 });
        }
      }
    );
    expect(versionMismatch).toMatchObject({
      status: "applied",
      current: NEXT,
      target: newer,
      channel: "beta"
    });
    expect(fetchCount).toBe(1);
    expect(readFileSync(paths.active, "utf8")).toContain(newer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
