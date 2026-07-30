import {
  constants as fsConstants,
  lstatSync,
  realpathSync,
  type Stats
} from "node:fs";
import path from "node:path";

export interface SafePathObservation {
  readonly path: string;
  readonly stats: Stats;
}

/**
 * Validates absolute, canonical, non-symlink paths with safe ownership and modes.
 * Matches ADR 010 Ownership Record path rules for macOS and Linux.
 */
export function assertSafeOwnedPath(
  value: string,
  options: {
    readonly label: string;
    readonly requireFile?: boolean;
    readonly requireDirectory?: boolean;
    readonly allowMissing?: boolean;
    readonly expectedModeMask?: number;
  }
): SafePathObservation | null {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${options.label} must be an absolute path`);
  }
  if (/(^|\/)\.\.?($|\/)/u.test(value) || value.includes("//")) {
    throw new Error(`${options.label} must be a canonical path`);
  }
  assertAncestorChain(value, options.label);
  let stats: Stats;
  try {
    stats = lstatSync(value);
  } catch (error) {
    if (options.allowMissing === true && isNotFound(error)) return null;
    throw new Error(`${options.label} is missing`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${options.label} must not be a symbolic link`);
  }
  if (options.requireFile === true && !stats.isFile()) {
    throw new Error(`${options.label} must be a regular file`);
  }
  if (options.requireDirectory === true && !stats.isDirectory()) {
    throw new Error(`${options.label} must be a directory`);
  }
  assertOwnerAndMode(stats, options.label);
  if (options.expectedModeMask !== undefined) {
    if ((stats.mode & 0o777) !== options.expectedModeMask) {
      throw new Error(`${options.label} has an unsafe mode`);
    }
  } else if ((stats.mode & 0o022) !== 0) {
    throw new Error(`${options.label} is group-writable or world-writable`);
  }
  const canonical = realpathSync(value);
  if (canonical !== value) {
    throw new Error(`${options.label} must be a canonical path`);
  }
  return Object.freeze({ path: value, stats });
}

export function assertSafeInstallRoot(installRoot: string): void {
  assertSafeOwnedPath(installRoot, {
    label: "Install Root",
    requireDirectory: true
  });
}

function assertAncestorChain(value: string, label: string): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) throw new Error(`${label} requires POSIX user identity`);
  let current = path.resolve(value);
  const seen = new Set<string>();
  while (current !== path.parse(current).root) {
    if (seen.has(current)) throw new Error(`${label} path chain is invalid`);
    seen.add(current);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (isNotFound(error)) {
        current = path.dirname(current);
        continue;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} path component must not be a symbolic link`);
    }
    if (!stats.isDirectory() && current !== path.resolve(value)) {
      throw new Error(`${label} path component must be a directory`);
    }
    if (stats.uid !== uid && stats.uid !== 0) {
      throw new Error(`${label} path component must be owned by the current user or root`);
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(`${label} path component is group-writable or world-writable`);
    }
    current = path.dirname(current);
  }
  // Root itself may be root-owned; only check it exists and is not a symlink.
  const root = path.parse(value).root || "/";
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink()) {
    throw new Error(`${label} file-system root must not be a symbolic link`);
  }
}

function assertOwnerAndMode(stats: Stats, label: string): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) throw new Error(`${label} requires POSIX user identity`);
  if (stats.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`${label} is group-writable or world-writable`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const OPEN_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
