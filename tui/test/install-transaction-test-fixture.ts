/** Shared fixtures for managed install-transaction recovery tests. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createInstallOwnershipRecord,
  serializeInstallOwnershipRecord
} from "../../shared/install-ownership-record.js";
import type { PublishedPlatformPackage } from "../../shared/release-targets.js";
import { releaseTargetForArtifact } from "../../shared/release-targets.js";
import { managedInstallPaths } from "../src/install-layout.js";
import { stubExecutableSource } from "./managed-package-fixture.js";

export const TXN_TEST_TARGET = "darwin-arm64" as const;
export const TXN_TEST_PACKAGE =
  releaseTargetForArtifact(TXN_TEST_TARGET).packageName as PublishedPlatformPackage;
export const TXN_TEST_CURRENT = "1.0.0";
export const TXN_TEST_NEXT = "1.1.0";
export const TXN_TEST_OLDER = "0.9.0";

export function txnScratchRoot(): string {
  const base = path.join(homedir(), ".cache", "1667-tests");
  mkdirSync(base, { recursive: true, mode: 0o755 });
  chmodSync(base, 0o755);
  return realpathSync(mkdtempSync(path.join(base, "txn-")));
}

export function writeTxnStub(filePath: string, version: string): void {
  writeFileSync(filePath, stubExecutableSource(version, TXN_TEST_TARGET), { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

export function shellTxnAuthority(
  installRoot: string,
  channel: "stable" | "beta" = "beta"
) {
  const paths = managedInstallPaths(installRoot);
  writeTxnStub(paths.active, TXN_TEST_CURRENT);
  const record = createInstallOwnershipRecord({
    installationId: randomBytes(16).toString("hex"),
    channel,
    installRoot,
    executable: paths.active,
    artifactTarget: TXN_TEST_TARGET
  });
  writeFileSync(paths.ownership, serializeInstallOwnershipRecord(record), { mode: 0o600 });
  chmodSync(paths.ownership, 0o600);
  return {
    paths,
    record,
    authority: {
      kind: "shell" as const,
      record,
      installRoot,
      executable: paths.active
    }
  };
}

export function managedTxn(
  phase: "candidate-ready" | "ownership-pending",
  record: ReturnType<typeof createInstallOwnershipRecord>,
  activeVersion: string,
  candidateVersion: string,
  operation: "upgrade" | "rollback" = "upgrade"
) {
  return {
    kind: "managed" as const,
    schemaVersion: 1 as const,
    phase,
    operation,
    channel: record.channel,
    updateChannel: false,
    activeVersion,
    candidateVersion,
    installationId: record.installationId,
    installRoot: record.installRoot,
    executable: record.executable,
    artifactTarget: record.artifactTarget
  };
}
