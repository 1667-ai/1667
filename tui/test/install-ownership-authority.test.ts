import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  INSTALL_ACTIVE_EXECUTABLE,
  INSTALL_OWNERSHIP_FILE
} from "../../shared/install-ownership-record.js";
import { INSTALL_ACTIVE_FILE } from "../src/install-layout.js";
import { resolveInstallationAuthority } from "../src/install-ownership.js";
import {
  MANAGED_TEST_TARGET as TARGET,
  managedScratchRoot,
  writeManagedStub
} from "./managed-package-fixture.js";

test("install layout reuses shared active basename policy", () => {
  expect(INSTALL_ACTIVE_FILE).toBe(INSTALL_ACTIVE_EXECUTABLE);
  expect(INSTALL_ACTIVE_EXECUTABLE).toBe("1667");
});

test("invalid Ownership Record layout grants no replacement authority", () => {
  // Missing or invalid records grant no replacement authority (manual only).
  const root = managedScratchRoot("authority-bad-layout-");
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const active = path.join(installRoot, INSTALL_ACTIVE_EXECUTABLE);
    writeManagedStub(active, "1.0.0", TARGET);
    // Bypass createInstallOwnershipRecord: write a layout-invalid record by hand.
    const bad = {
      schemaVersion: 1,
      product: "1667",
      installationId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      method: "shell",
      channel: "beta",
      installRoot,
      executable: path.join(installRoot, "not-the-active-name"),
      artifactTarget: TARGET
    };
    writeFileSync(
      path.join(installRoot, INSTALL_OWNERSHIP_FILE),
      `${JSON.stringify(bad)}\n`,
      { mode: 0o600 }
    );
    chmodSync(path.join(installRoot, INSTALL_OWNERSHIP_FILE), 0o600);
    const authority = resolveInstallationAuthority(active);
    expect(authority.kind).toBe("manual");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing Ownership Record grants no replacement authority", () => {
  const root = managedScratchRoot("authority-missing-");
  try {
    const installRoot = path.join(root, "bin");
    mkdirSync(installRoot, { mode: 0o755 });
    chmodSync(installRoot, 0o755);
    const active = path.join(installRoot, INSTALL_ACTIVE_EXECUTABLE);
    writeManagedStub(active, "1.0.0", TARGET);
    const authority = resolveInstallationAuthority(active);
    expect(authority.kind).toBe("manual");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
