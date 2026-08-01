import {
  readFileSync,
  realpathSync,
  lstatSync
} from "node:fs";
import path from "node:path";
import {
  AI_1667_BUILD_IDENTITY,
  AI_1667_PRODUCT,
  type ArtifactTarget
} from "../../shared/build-identity.js";
import {
  INSTALL_OWNERSHIP_FILE,
  RECORD_KEYS,
  parseInstallOwnershipRecordText,
  serializeInstallOwnershipRecord,
  type InstallChannel,
  type InstallOwnershipRecord
} from "../../shared/install-ownership-record.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";
import {
  fsyncDirectory,
  removeQuietly,
  writeExclusiveFile
} from "../../shared/safe-file-write.js";
import { assertSafeOwnedPath, assertSafeInstallRoot } from "./install-path-safety.js";

export type InstallationAuthority =
  | { readonly kind: "manual" }
  | {
      readonly kind: "powershell";
      readonly channel: InstallChannel;
      readonly installRoot: string;
      readonly executable: string;
    }
  | {
      readonly kind: "shell";
      readonly record: InstallOwnershipRecord;
      readonly installRoot: string;
      readonly executable: string;
    };

/**
 * Reads authority only from the Ownership Record next to the invoked executable.
 * Missing or invalid records grant no replacement authority.
 */
export function resolveInstallationAuthority(
  executablePath = process.execPath,
  artifactTarget: ArtifactTarget = AI_1667_BUILD_IDENTITY.artifactTarget
): InstallationAuthority {
  if (process.platform === "win32") {
    return resolvePowerShellInstallationAuthority(executablePath, artifactTarget);
  }
  try {
    const executable = resolveExecutablePath(executablePath);
    const installRoot = path.dirname(executable);
    const recordPath = path.join(installRoot, INSTALL_OWNERSHIP_FILE);
    const recordFile = assertSafeOwnedPath(recordPath, {
      label: "Ownership Record",
      requireFile: true,
      expectedModeMask: 0o600
    });
    if (recordFile === null) return { kind: "manual" };
    const text = readFileSync(recordPath, "utf8");
    const record = parseInstallOwnershipRecordText(text);
    assertSafeInstallRoot(record.installRoot);
    const boundExecutable = resolveExecutablePath(record.executable);
    if (record.installRoot !== installRoot) {
      return { kind: "manual" };
    }
    if (boundExecutable !== executable || record.executable !== executable) {
      return { kind: "manual" };
    }
    if (record.product !== AI_1667_PRODUCT || record.method !== "shell") {
      return { kind: "manual" };
    }
    const target = artifactTarget;
    if (target === "source" || record.artifactTarget !== target) {
      return { kind: "manual" };
    }
    assertSafeOwnedPath(executable, {
      label: "managed executable",
      requireFile: true
    });
    return Object.freeze({
      kind: "shell",
      record,
      installRoot,
      executable
    });
  } catch {
    return { kind: "manual" };
  }
}

function resolvePowerShellInstallationAuthority(
  executablePath: string,
  artifactTarget: ArtifactTarget
): InstallationAuthority {
  try {
    const executable = resolveWindowsExecutablePath(executablePath);
    if (path.win32.basename(executable).toLowerCase() !== "1667.exe") {
      return { kind: "manual" };
    }
    const installRoot = path.win32.dirname(executable);
    const recordPath = path.win32.join(installRoot, INSTALL_OWNERSHIP_FILE);
    const recordStats = lstatSync(recordPath);
    if (!recordStats.isFile() || recordStats.isSymbolicLink() || recordStats.size > 16_384) {
      return { kind: "manual" };
    }
    const value = parseJsonRejectingDuplicateKeys(readFileSync(recordPath, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { kind: "manual" };
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expected = [...RECORD_KEYS].sort();
    if (keys.length !== expected.length
      || keys.some((key, index) => key !== expected[index])) {
      return { kind: "manual" };
    }
    const channel = record.channel;
    if (record.schemaVersion !== 1
      || record.product !== AI_1667_PRODUCT
      || record.method !== "powershell"
      || record.artifactTarget !== "windows-x64"
      || (channel !== "stable" && channel !== "beta")
      || typeof record.installationId !== "string"
      || !/^[0-9a-f]{32}$/u.test(record.installationId)
      || !windowsPathEquals(record.installRoot, installRoot)
      || !windowsPathEquals(record.executable, executable)
      || artifactTarget !== "windows-x64") {
      return { kind: "manual" };
    }
    return Object.freeze({ kind: "powershell", channel, installRoot, executable });
  } catch {
    return { kind: "manual" };
  }
}

export function writeOwnershipRecordAtomic(
  record: InstallOwnershipRecord
): void {
  assertSafeInstallRoot(record.installRoot);
  const finalPath = path.join(record.installRoot, INSTALL_OWNERSHIP_FILE);
  const temporary = path.join(
    record.installRoot,
    `.1667-install.json.${process.pid}.tmp`
  );
  removeQuietly(temporary);
  writeExclusiveFile({
    path: temporary,
    data: serializeInstallOwnershipRecord(record),
    mode: 0o600,
    finalPath
  });
  fsyncDirectory(record.installRoot);
}

function resolveExecutablePath(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error("Executable path must be absolute");
  }
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Executable path must be a regular file");
  }
  // Do not realpath across unexpected links; require the path itself is canonical.
  const real = realpathNoFollowFile(value);
  if (real !== value) throw new Error("Executable path must be canonical");
  return value;
}

function resolveWindowsExecutablePath(value: string): string {
  if (!path.win32.isAbsolute(value) || value.startsWith("\\\\")) {
    throw new Error("Executable path must be an absolute local path");
  }
  const stats = lstatSync(value);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Executable path must be a regular file");
  }
  const canonical = path.win32.join(realpathSync(path.win32.dirname(value)), path.win32.basename(value));
  if (!windowsPathEquals(canonical, value)) {
    throw new Error("Executable path must be canonical");
  }
  return canonical;
}

function windowsPathEquals(left: unknown, right: string): boolean {
  return typeof left === "string"
    && path.win32.isAbsolute(left)
    && !left.startsWith("\\\\")
    && path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
}

function realpathNoFollowFile(value: string): string {
  // realpathSync follows the final path components; reject if any component differs.
  const realDirectory = path.dirname(value);
  const base = path.basename(value);
  const resolvedDir = realpathSync(realDirectory);
  return path.join(resolvedDir, base);
}
