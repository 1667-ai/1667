import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { serializeInstallOwnershipRecord } from "../../shared/install-ownership-record.js";
import { removeQuietly } from "../../shared/safe-file-write.js";
import {
  acquireInstallationLock,
  recoverInstallationTransaction,
  writeTransactionRecord
} from "../src/install-transaction.js";
import { downloadPlatformPackage } from "../src/upgrade-download.js";
import { executeUpgradeCli } from "../src/upgrade-cli.js";
import { createUpgradeProgressRenderer } from "../src/upgrade-progress.js";
import {
  MANAGED_TEST_CURRENT as CURRENT,
  MANAGED_TEST_NEXT as NEXT,
  MANAGED_TEST_PACKAGE as PACKAGE,
  MANAGED_TEST_TARGET as TARGET,
  buildCanonicalPlatformPackage,
  fakeManagedRegistry,
  managedScratchRoot,
  managedTxn,
  shellManagedAuthority,
  writeManagedStub
} from "./managed-package-fixture.js";

test("unqualified managed upgrade defaults to Ownership Record channel beta", async () => {
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority } = shellManagedAuthority(installRoot, "beta");
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    let progressEvents = 0;
    const result = await executeUpgradeCli(["--json"], {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: fakeManagedRegistry(NEXT, PACKAGE, pkg.integrity, pkg.tarballUrl),
      fetcher: async () => new Response(new Uint8Array(pkg.bytes), { status: 200 }),
      onDownloadProgress: () => {
        progressEvents += 1;
      },
      defaultChannel: "stable"
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      status: "applied",
      channel: "beta",
      method: "shell"
    });
    expect(progressEvents).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed human upgrade renders live download progress", async () => {
  const root = managedScratchRoot("progress-");
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority } = shellManagedAuthority(installRoot, "stable");
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    const writes: string[] = [];
    const result = await executeUpgradeCli([], {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE
      },
      registry: fakeManagedRegistry(NEXT, PACKAGE, pkg.integrity, pkg.tarballUrl),
      fetcher: async () => new Response(new Uint8Array(pkg.bytes), {
        status: 200,
        headers: { "content-length": String(pkg.bytes.byteLength) }
      }),
      onDownloadProgress: createUpgradeProgressRenderer((text) => writes.push(text), 32)
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Upgraded 1667 from ${CURRENT} to ${NEXT}.`);
    expect(result.stderr).toBe("");
    const progress = writes.join("");
    expect(progress).toContain("\rDownloading [");
    expect(progress).toContain("100%");
    expect(progress.endsWith("\n")).toBe(true);
    for (const update of progress.split("\r").filter(Boolean)) {
      expect(update.replace(/\n$/u, "").length <= 32).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed check reports available for shell installs", async () => {
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority } = shellManagedAuthority(installRoot, "stable");
    const result = await executeUpgradeCli(["--check", "--json"], {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: fakeManagedRegistry(
        NEXT,
        PACKAGE,
        "sha512-" + "A".repeat(86) + "==",
        `https://registry.npmjs.org/${PACKAGE}/-/${path.basename(PACKAGE)}-${NEXT}.tgz`
      )
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      status: "available",
      method: "shell",
      target: NEXT,
      restartRequired: false
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed output tells the reader what to do and not how it was installed", async () => {
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority } = shellManagedAuthority(installRoot, "stable");
    const result = await executeUpgradeCli(["--check"], {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: fakeManagedRegistry(
        NEXT,
        PACKAGE,
        "sha512-" + "A".repeat(86) + "==",
        `https://registry.npmjs.org/${PACKAGE}/-/${path.basename(PACKAGE)}-${NEXT}.tgz`
      )
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`1667 ${NEXT} is available`);
    expect(result.stdout).toContain("Run '1667 upgrade' to install it.");
    // The reader can update this installation, so a sentence about who
    // installed it tells them nothing they can act on.
    expect(result.stdout).not.toContain("this copy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a group-writable Install Root upgrades", async () => {
  // Debian, Ubuntu, and Homebrew each ship a directory like this, and Ubuntu
  // gives every user a private group, so the group holds nobody but the owner.
  // Refusing the upgrade here protected nobody and stranded the installation.
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    const { authority } = shellManagedAuthority(installRoot, "stable");
    chmodSync(installRoot, 0o775);
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    const result = await executeUpgradeCli(["--json"], {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry: fakeManagedRegistry(NEXT, PACKAGE, pkg.integrity, pkg.tarballUrl),
      fetcher: async () => new Response(new Uint8Array(pkg.bytes), { status: 200 })
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      status: "applied",
      method: "shell",
      current: CURRENT,
      target: NEXT
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom registry platform metadata is used without live npm access", async () => {
  // Regression: apply must use injected registry.platform only. A silent
  // NpmUpgradeRegistry fallback would request live registry metadata.
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority } = shellManagedAuthority(installRoot, "beta");
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    let platformCalls = 0;
    const registry = {
      async channelHead() {
        return NEXT;
      },
      async launcher(version: string) {
        return {
          name: "@1667-ai/cli",
          version,
          integrity: pkg.integrity,
          tarball: "https://example.invalid/launcher.tgz"
        };
      },
      async platform(name: typeof PACKAGE, version: string) {
        platformCalls += 1;
        return {
          name,
          version,
          integrity: pkg.integrity,
          tarball: pkg.tarballUrl
        };
      }
    };
    const result = await executeUpgradeCli(["--channel", "beta", "--json"], {
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        },
      registry,
      fetcher: async (input) => {
        const url = String(input);
        // Tarball paths contain "/-/"; exact-version metadata paths do not.
        if (url.includes("registry.npmjs.org") && !url.includes("/-/")) {
          throw new Error("hidden live npm metadata access");
        }
        if (url === pkg.tarballUrl) {
          return new Response(new Uint8Array(pkg.bytes), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }
    });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      status: "applied",
      target: NEXT,
      method: "shell"
    });
    // Plan resolves platform once; apply reuses that metadata (no second fetch).
    expect(platformCalls).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed upgrade, offline double rollback, ownership-pending recovery", async () => {
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths, record } = shellManagedAuthority(installRoot, "beta");
    const pkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    const registry = fakeManagedRegistry(NEXT, PACKAGE, pkg.integrity, pkg.tarballUrl);
    const fetcher: typeof fetch = async (input) => {
      if (String(input) === pkg.tarballUrl) {
        return new Response(new Uint8Array(pkg.bytes), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    };
    const observation = {
      currentVersion: CURRENT,
      platformPackage: PACKAGE,
      };

    writeFileSync(path.join(root, "evil"), "x");
    symlinkSync(path.join(root, "evil"), paths.packageStaging);
    let symlinkThrew = false;
    try {
      await downloadPlatformPackage({
        tarballUrl: pkg.tarballUrl,
        packageName: PACKAGE,
        version: NEXT,
        integrity: pkg.integrity,
        destinationPath: paths.packageStaging,
        signal: new AbortController().signal,
        fetcher: async () => new Response(new Uint8Array(pkg.bytes), { status: 200 })
      });
    } catch {
      symlinkThrew = true;
    }
    expect(symlinkThrew).toBe(true);
    removeQuietly(paths.packageStaging);

    const upgraded = await executeUpgradeCli(["--channel", "beta", "--json"], {
      authority,
      observation,
      registry,
      fetcher
    });
    expect(upgraded.exitCode).toBe(0);
    expect(upgraded.envelope).toMatchObject({
      status: "applied",
      method: "shell",
      restartRequired: true,
      current: CURRENT,
      target: NEXT
    });

    const rolled = await executeUpgradeCli(["--rollback", "--json"], {
      authority: { kind: "shell", record, installRoot, executable: paths.active },
      observation: { currentVersion: NEXT, platformPackage: PACKAGE },
      registry,
      fetcher: async () => {
        throw new Error("network should not be used for rollback");
      }
    });
    expect(rolled.exitCode).toBe(0);
    expect(readFileSync(paths.active, "utf8")).toContain(CURRENT);

    const rolledBack = await executeUpgradeCli(["--rollback", "--json"], {
      authority: { kind: "shell", record, installRoot, executable: paths.active },
      observation: { currentVersion: CURRENT, platformPackage: PACKAGE },
      registry,
      fetcher: async () => {
        throw new Error("network should not be used for rollback");
      }
    });
    expect(rolledBack.exitCode).toBe(0);
    expect(readFileSync(paths.active, "utf8")).toContain(NEXT);

    writeManagedStub(paths.active, NEXT);
    writeManagedStub(paths.previous, CURRENT);
    writeTransactionRecord(paths, {
      ...managedTxn("ownership-pending", record, CURRENT, NEXT),
      updateChannel: true,
      channel: "stable"
    });
    writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
    const lock = await acquireInstallationLock(installRoot);
    try {
      await recoverInstallationTransaction(authority, lock.paths);
      const ownership = JSON.parse(readFileSync(paths.ownership, "utf8")) as { channel: string };
      expect(ownership.channel).toBe("stable");
      expect(existsSync(paths.transaction)).toBe(false);
    } finally {
      await lock.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale observation is replaced by locked active; no double mutation", async () => {
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths } = shellManagedAuthority(installRoot, "beta");
    writeManagedStub(paths.active, NEXT);
    writeManagedStub(paths.previous, CURRENT);

    const headPkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    let fetchCount = 0;
    const registry = fakeManagedRegistry(NEXT, PACKAGE, headPkg.integrity, headPkg.tarballUrl);
    const { applyUpgrade, applyRollback } = await import("../src/upgrade-apply.js");

    // Observation behind active (CURRENT vs locked NEXT), head NEXT → no-op under lock.
    const staleUpToDate = await applyUpgrade(
      { kind: "apply", version: null, channel: "beta" },
      {
        authority,
        observation: {
          currentVersion: CURRENT,
          platformPackage: PACKAGE,
          },
        registry,
        fetcher: async () => {
          fetchCount += 1;
          return new Response(new Uint8Array(headPkg.bytes), { status: 200 });
        }
      }
    );
    expect(staleUpToDate).toMatchObject({
      status: "up-to-date",
      current: NEXT,
      latest: NEXT,
      target: null
    });
    expect(fetchCount).toBe(0);
    expect(existsSync(paths.transaction)).toBe(false);
    expect(readFileSync(paths.active, "utf8")).toContain(NEXT);
    expect(readFileSync(paths.active, "utf8")).not.toContain(CURRENT);

    const newer = "1.2.0";
    const newerPkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: newer,
      target: TARGET
    });
    const newerRegistry = fakeManagedRegistry(newer, PACKAGE, newerPkg.integrity, newerPkg.tarballUrl);
    fetchCount = 0;
    const applied = await applyUpgrade(
      { kind: "apply", version: null, channel: "beta" },
      {
        authority,
        observation: {
          currentVersion: CURRENT,
          platformPackage: PACKAGE,
          },
        registry: newerRegistry,
        fetcher: async () => {
          fetchCount += 1;
          return new Response(new Uint8Array(newerPkg.bytes), { status: 200 });
        }
      }
    );
    expect(applied).toMatchObject({
      status: "applied",
      current: NEXT,
      target: newer,
      latest: newer
    });
    expect(applied.current).not.toBe(CURRENT);
    expect(fetchCount).toBe(1);
    expect(existsSync(paths.transaction)).toBe(false);
    expect(readFileSync(paths.active, "utf8")).toContain(newer);
    expect(readFileSync(paths.previous, "utf8")).toContain(NEXT);
    expect(readFileSync(paths.previous, "utf8")).not.toContain(CURRENT);

    const rolled = await applyRollback({
      authority,
      observation: {
        currentVersion: CURRENT,
        platformPackage: PACKAGE,
        }
    });
    expect(rolled).toMatchObject({
      status: "applied",
      current: newer,
      target: NEXT
    });
    expect(rolled.current).not.toBe(CURRENT);
    expect(readFileSync(paths.active, "utf8")).toContain(NEXT);
    expect(existsSync(paths.transaction)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reverse race: observation ahead of locked active still upgrades once", async () => {
  // Observation says NEXT (thinks already current) but active was rolled back to CURRENT.
  // Pre-lock plan would be up-to-date; locked plan must apply CURRENT→NEXT exactly once.
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths } = shellManagedAuthority(installRoot, "beta");
    writeManagedStub(paths.active, CURRENT);
    writeManagedStub(paths.previous, NEXT);

    const headPkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    let fetchCount = 0;
    const registry = fakeManagedRegistry(NEXT, PACKAGE, headPkg.integrity, headPkg.tarballUrl);
    const { applyUpgrade } = await import("../src/upgrade-apply.js");

    const applied = await applyUpgrade(
      { kind: "apply", version: null, channel: "beta" },
      {
        authority,
        observation: {
          currentVersion: NEXT,
          platformPackage: PACKAGE,
          },
        registry,
        fetcher: async () => {
          fetchCount += 1;
          return new Response(new Uint8Array(headPkg.bytes), { status: 200 });
        }
      }
    );
    expect(applied).toMatchObject({
      status: "applied",
      current: CURRENT,
      target: NEXT,
      latest: NEXT
    });
    expect(fetchCount).toBe(1);
    expect(existsSync(paths.transaction)).toBe(false);
    expect(readFileSync(paths.active, "utf8")).toContain(NEXT);

    // Second call with matching observation and locked active is a true no-op.
    fetchCount = 0;
    const noop = await applyUpgrade(
      { kind: "apply", version: null, channel: "beta" },
      {
        authority,
        observation: {
          currentVersion: NEXT,
          platformPackage: PACKAGE,
          },
        registry,
        fetcher: async () => {
          fetchCount += 1;
          return new Response(new Uint8Array(headPkg.bytes), { status: 200 });
        }
      }
    );
    expect(noop).toMatchObject({
      status: "up-to-date",
      current: NEXT,
      latest: NEXT,
      target: null
    });
    expect(fetchCount).toBe(0);
    expect(readFileSync(paths.active, "utf8")).toContain(NEXT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("up-to-date beta->stable channel switch persists requested channel on disk", async () => {
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths } = shellManagedAuthority(installRoot, "beta", NEXT);
    const headPkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    const registry = fakeManagedRegistry(NEXT, PACKAGE, headPkg.integrity, headPkg.tarballUrl);
    const { applyUpgrade } = await import("../src/upgrade-apply.js");

    const result = await applyUpgrade(
      { kind: "apply", version: null, channel: "stable" },
      {
        authority,
        observation: {
          currentVersion: NEXT,
          platformPackage: PACKAGE,
          },
        registry,
        fetcher: async () => {
          throw new Error("network must not run for an up-to-date channel switch");
        }
      }
    );
    expect(result).toMatchObject({
      status: "up-to-date",
      current: NEXT,
      latest: NEXT,
      channel: "stable"
    });
    const ownership = JSON.parse(readFileSync(paths.ownership, "utf8")) as { channel: string };
    expect(ownership.channel).toBe("stable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact version request that is already active does not change channel", async () => {
  const root = managedScratchRoot();
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const { authority, paths } = shellManagedAuthority(installRoot, "beta", NEXT);
    const headPkg = buildCanonicalPlatformPackage({
      packageName: PACKAGE,
      version: NEXT,
      target: TARGET
    });
    const registry = fakeManagedRegistry(NEXT, PACKAGE, headPkg.integrity, headPkg.tarballUrl);
    const { applyUpgrade } = await import("../src/upgrade-apply.js");

    const result = await applyUpgrade(
      { kind: "apply", version: NEXT, channel: "stable" },
      {
        authority,
        observation: {
          currentVersion: NEXT,
          platformPackage: PACKAGE,
          },
        registry,
        fetcher: async () => {
          throw new Error("network must not run for an exact up-to-date request");
        }
      }
    );
    expect(result).toMatchObject({
      status: "up-to-date",
      current: NEXT,
      latest: NEXT
    });
    const ownership = JSON.parse(readFileSync(paths.ownership, "utf8")) as { channel: string };
    expect(ownership.channel).toBe("beta");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
