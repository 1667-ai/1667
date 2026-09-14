import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from "node:fs";
import path from "node:path";
import { probeReleaseExecutable } from "../../shared/executable-probe.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";
import { isSemVer } from "../../shared/semver.js";
import { acquireInstallationLock } from "./install-lock.js";
import type { InstallationAuthority } from "./install-ownership.js";
import {
  readPowerShellOwnershipRecord,
  windowsPathEquals,
  WINDOWS_UPGRADE_FAILURE_FILE,
  WINDOWS_UPGRADE_WORK_PREFIX
} from "./windows-upgrade-state.js";

type PowerShellAuthority = Extract<InstallationAuthority, { kind: "powershell" }>;
type ActiveState = "unchanged" | "restored" | "target-preserved";

interface WindowsUpgradeFailureRecord {
  readonly schemaVersion: 1;
  readonly product: "1667";
  readonly installationId: string;
  readonly workRoot: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly targetChannel: "stable" | "beta";
  readonly activeState: ActiveState;
  readonly message: string;
}

interface WindowsUpgradeHandoffRecord {
  readonly installationId: string;
  readonly installRoot: string;
  readonly executable: string;
  readonly expectedChannel: "stable" | "beta";
  readonly targetChannel: "stable" | "beta";
  readonly updateChannel: boolean;
  readonly candidate: string;
  readonly candidateSha256: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
}

export type WindowsUpgradeFailureRecoverer = (
  authority: PowerShellAuthority
) => string | null | Promise<string | null>;

const FAILURE_KEYS = [
  "activeState",
  "fromVersion",
  "installationId",
  "message",
  "product",
  "schemaVersion",
  "targetChannel",
  "targetVersion",
  "workRoot"
] as const;
const REQUEST_KEYS = [
  "candidate",
  "candidateSha256",
  "currentVersion",
  "executable",
  "expectedChannel",
  "installRoot",
  "installationId",
  "targetChannel",
  "targetVersion",
  "updateChannel"
] as const;
const WORK_FILES = new Set([
  ".1667-install.json",
  ".1667-install.json.previous",
  "1667-candidate.exe",
  "1667-failed.exe",
  "1667-previous.exe",
  "error.txt",
  "failure-record.tmp",
  "failure-record.tmp.previous",
  "handoff.ps1",
  "release-package.tgz",
  "request.json",
  "transaction.json",
  "transaction.json.tmp",
  "transaction.json.tmp.previous"
]);

/** Surface one authenticated helper failure and make a new attempt safe. */
export async function recoverWindowsUpgradeFailure(
  authority: PowerShellAuthority
): Promise<string | null> {
  const failurePath = path.win32.join(
    authority.installRoot,
    WINDOWS_UPGRADE_FAILURE_FILE
  );
  // Most runs have no result to recover. Do not create an Install Root lock
  // only to prove that the fixed marker is absent.
  try {
    lstatSync(failurePath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const lock = await acquireInstallationLock(authority.installRoot);
  try {
    const failureText = readBoundedRegularFile(failurePath, 4096, true);
    if (failureText === null) return null;

    const ownership = readPowerShellOwnershipRecord(authority);
    const failure = parseFailureRecord(failureText);
    if (failure.installationId !== ownership.installationId) {
      throw new Error("Windows upgrade failure belongs to another installation");
    }
    const workRoot = resolveOwnedWorkRoot(authority.installRoot, failure.workRoot);
    const requestText = readBoundedRegularFile(
      path.win32.join(workRoot, "request.json"),
      16_384,
      false
    );
    const request = parseHandoffRecord(requestText!);
    assertBoundRequest(request, failure, authority, workRoot);
    assertRemovableWorkRoot(workRoot);

    const activeVersion = failure.activeState === "target-preserved"
      ? failure.targetVersion
      : failure.fromVersion;
    await probeReleaseExecutable(authority.executable, {
      version: activeVersion,
      artifactTarget: "windows-x64"
    }, { timeoutMs: 5000 });

    // Remove the marker first. A validated but still-open work directory does
    // not block a new unique attempt, and cleanup can finish best-effort.
    unlinkSync(failurePath);
    removeValidatedWorkRoot(workRoot);
    return failure.message;
  } finally {
    await lock.release();
  }
}

function parseFailureRecord(text: string): WindowsUpgradeFailureRecord {
  const record = parseObject(text, FAILURE_KEYS, "Windows upgrade failure");
  if (record.schemaVersion !== 1
    || record.product !== "1667"
    || typeof record.installationId !== "string"
    || !/^[0-9a-f]{32}$/u.test(record.installationId)
    || typeof record.workRoot !== "string"
    || typeof record.fromVersion !== "string"
    || !isSemVer(record.fromVersion)
    || typeof record.targetVersion !== "string"
    || !isSemVer(record.targetVersion)
    || (record.targetChannel !== "stable" && record.targetChannel !== "beta")
    || !isActiveState(record.activeState)
    || typeof record.message !== "string"
    || record.message.length === 0
    || record.message.length > 512
    || /[\u0000-\u001f\u007f]/u.test(record.message)) {
    throw new Error("Windows upgrade failure is invalid");
  }
  return record as unknown as WindowsUpgradeFailureRecord;
}

function parseHandoffRecord(text: string): WindowsUpgradeHandoffRecord {
  const record = parseObject(text, REQUEST_KEYS, "Windows upgrade handoff request");
  if (typeof record.installationId !== "string"
    || !/^[0-9a-f]{32}$/u.test(record.installationId)
    || typeof record.installRoot !== "string"
    || typeof record.executable !== "string"
    || (record.expectedChannel !== "stable" && record.expectedChannel !== "beta")
    || (record.targetChannel !== "stable" && record.targetChannel !== "beta")
    || typeof record.updateChannel !== "boolean"
    || typeof record.candidate !== "string"
    || typeof record.candidateSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.candidateSha256)
    || typeof record.currentVersion !== "string"
    || !isSemVer(record.currentVersion)
    || typeof record.targetVersion !== "string"
    || !isSemVer(record.targetVersion)) {
    throw new Error("Windows upgrade handoff request is invalid");
  }
  return record as unknown as WindowsUpgradeHandoffRecord;
}

function parseObject(
  text: string,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  const value = parseJsonRejectingDuplicateKeys(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} is invalid`);
  }
  return record;
}

function resolveOwnedWorkRoot(installRoot: string, basename: string): string {
  if (path.win32.basename(basename) !== basename
    || !basename.startsWith(WINDOWS_UPGRADE_WORK_PREFIX)
    || basename.length <= WINDOWS_UPGRADE_WORK_PREFIX.length
    || basename.length > WINDOWS_UPGRADE_WORK_PREFIX.length + 64) {
    throw new Error("Windows upgrade work directory is invalid");
  }
  const workRoot = path.win32.join(installRoot, basename);
  const stats = lstatSync(workRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Windows upgrade work directory is invalid");
  }
  const realInstallRoot = realpathSync(installRoot);
  const realWorkRoot = realpathSync(workRoot);
  if (!windowsPathEquals(path.win32.dirname(realWorkRoot), realInstallRoot)
    || path.win32.basename(realWorkRoot) !== basename) {
    throw new Error("Windows upgrade work directory left the Install Root");
  }
  return workRoot;
}

function assertBoundRequest(
  request: WindowsUpgradeHandoffRecord,
  failure: WindowsUpgradeFailureRecord,
  authority: PowerShellAuthority,
  workRoot: string
): void {
  if (request.installationId !== failure.installationId
    || !windowsPathEquals(request.installRoot, authority.installRoot)
    || !windowsPathEquals(request.executable, authority.executable)
    || request.expectedChannel !== authority.channel
    || request.currentVersion !== failure.fromVersion
    || request.targetVersion !== failure.targetVersion
    || request.targetChannel !== failure.targetChannel
    || !windowsPathEquals(
      request.candidate,
      path.win32.join(workRoot, "1667-candidate.exe")
    )) {
    throw new Error("Windows upgrade failure does not match its handoff request");
  }
}

function assertRemovableWorkRoot(workRoot: string): void {
  const entries = readdirSync(workRoot, { withFileTypes: true });
  if (entries.length > WORK_FILES.size) {
    throw new Error("Windows upgrade work directory has unexpected files");
  }
  for (const entry of entries) {
    if (!WORK_FILES.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Windows upgrade work directory has unexpected files");
    }
    const stats = lstatSync(path.win32.join(workRoot, entry.name));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Windows upgrade work directory has an unsafe file");
    }
  }
}

function removeValidatedWorkRoot(workRoot: string): void {
  try {
    for (const entry of readdirSync(workRoot, { withFileTypes: true })) {
      if (WORK_FILES.has(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
        unlinkSync(path.win32.join(workRoot, entry.name));
      }
    }
    rmdirSync(workRoot);
  } catch {
    // A helper can still have this directory as its working directory. The
    // unique stale directory does not block the next attempt.
  }
}

function readBoundedRegularFile(
  file: string,
  maxBytes: number,
  allowMissing: boolean
): string | null {
  let stats;
  try {
    stats = lstatSync(file);
  } catch (error) {
    if (allowMissing && isNotFound(error)) return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > maxBytes) {
    throw new Error("Windows upgrade state file is invalid");
  }
  return readFileSync(file, "utf8");
}

function isActiveState(value: unknown): value is ActiveState {
  return value === "unchanged" || value === "restored" || value === "target-preserved";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
