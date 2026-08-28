import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { AI_1667_PRODUCT } from "../../shared/build-identity.js";
import {
  INSTALL_OWNERSHIP_FILE,
  RECORD_KEYS
} from "../../shared/install-ownership-record.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";
import type { InstallationAuthority } from "./install-ownership.js";
import type { UpgradeChannel } from "./upgrade-contract.js";

export const WINDOWS_UPGRADE_FAILURE_FILE = ".1667-upgrade-failure.json" as const;
export const WINDOWS_UPGRADE_WORK_PREFIX = ".1667-upgrade." as const;

export interface PowerShellOwnershipRecord {
  readonly schemaVersion: 1;
  readonly product: typeof AI_1667_PRODUCT;
  readonly installationId: string;
  readonly method: "powershell";
  readonly channel: UpgradeChannel;
  readonly installRoot: string;
  readonly executable: string;
  readonly artifactTarget: "windows-x64";
}

export function readPowerShellOwnershipRecord(
  authority: Extract<InstallationAuthority, { kind: "powershell" }>
): PowerShellOwnershipRecord {
  const recordPath = path.win32.join(authority.installRoot, INSTALL_OWNERSHIP_FILE);
  const stats = lstatSync(recordPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > 16_384) {
    throw new Error("Ownership Record is invalid");
  }
  const value = parseJsonRejectingDuplicateKeys(readFileSync(recordPath, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ownership Record is invalid");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [...RECORD_KEYS].sort();
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || record.schemaVersion !== 1
    || record.product !== AI_1667_PRODUCT
    || record.method !== "powershell"
    || record.artifactTarget !== "windows-x64"
    || (record.channel !== "stable" && record.channel !== "beta")
    || record.channel !== authority.channel
    || !windowsPathEquals(record.installRoot, authority.installRoot)
    || !windowsPathEquals(record.executable, authority.executable)
    || typeof record.installationId !== "string"
    || !/^[0-9a-f]{32}$/u.test(record.installationId)) {
    throw new Error("Ownership Record changed before the Windows upgrade");
  }
  return record as unknown as PowerShellOwnershipRecord;
}

export function windowsPathEquals(left: unknown, right: string): boolean {
  return typeof left === "string"
    && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}
