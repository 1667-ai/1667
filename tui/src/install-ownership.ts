import {
  readFileSync,
  realpathSync,
  lstatSync
} from "node:fs";
import path from "node:path";
import {
  AI_1667_BUILD_IDENTITY,
  AI_1667_PRODUCT
} from "../../shared/build-identity.js";
import {
  INSTALL_OWNERSHIP_FILE,
  parseInstallOwnershipRecordText,
  serializeInstallOwnershipRecord,
  type InstallOwnershipRecord
} from "../../shared/install-ownership-record.js";
import {
  fsyncDirectory,
  removeQuietly,
  writeExclusiveFile
} from "../../shared/safe-file-write.js";
import { assertSafeOwnedPath, assertSafeInstallRoot } from "./install-path-safety.js";

export type InstallationAuthority =
  | { readonly kind: "manual" }
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
  executablePath = process.execPath
): InstallationAuthority {
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
    const target = AI_1667_BUILD_IDENTITY.artifactTarget;
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

function realpathNoFollowFile(value: string): string {
  // realpathSync follows the final path components; reject if any component differs.
  const realDirectory = path.dirname(value);
  const base = path.basename(value);
  const resolvedDir = realpathSync(realDirectory);
  return path.join(resolvedDir, base);
}
