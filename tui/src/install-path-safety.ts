import {
  constants as fsConstants,
  statSync,
  type Stats
} from "node:fs";
import path from "node:path";

export interface SafePathObservation {
  readonly path: string;
  readonly stats: Stats;
}

/**
 * Validates that a path is absolute and canonical, has the shape the caller
 * needs, and belongs to the current user. Matches the ADR 010 Ownership Record
 * path rules for macOS and Linux.
 *
 * These checks find a mistake the current user made, such as an Install Root
 * that an earlier `sudo` left owned by root. They never protected against a
 * program that already runs as the current user, because such a program can
 * write to the Install Root whatever its mode is.
 *
 * The mode and path-component rules are gone. They refused a directory layout
 * that Debian, Ubuntu, and Homebrew all ship: a group-writable directory whose
 * group holds nobody except the owner. The refusal named a real bit and no real
 * exposure, and it sent a person to a different prefix for no gain.
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
  let stats: Stats;
  try {
    // Follows a symbolic link, so a person can keep a linked bin directory and
    // still have the shape and the owner of the real target checked.
    stats = statSync(value);
  } catch (error) {
    if (options.allowMissing === true && isNotFound(error)) return null;
    throw new Error(`${options.label} is missing`);
  }
  if (options.requireFile === true && !stats.isFile()) {
    throw new Error(`${options.label} must be a regular file`);
  }
  if (options.requireDirectory === true && !stats.isDirectory()) {
    throw new Error(`${options.label} must be a directory`);
  }
  assertOwner(stats, options.label);
  // An exact mode still applies to a file 1667 writes itself, such as the
  // Ownership Record at 0600. That check reads 1667's own work, and refuses no
  // layout that a person chose.
  if (options.expectedModeMask !== undefined
    && (stats.mode & 0o777) !== options.expectedModeMask) {
    throw new Error(`${options.label} has an unsafe mode`);
  }
  return Object.freeze({ path: value, stats });
}

export function assertSafeInstallRoot(installRoot: string): void {
  assertSafeOwnedPath(installRoot, {
    label: "Install Root",
    requireDirectory: true
  });
}

function assertOwner(stats: Stats, label: string): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) throw new Error(`${label} requires POSIX user identity`);
  if (stats.uid !== uid) {
    throw new Error(`${label} must be owned by the current user`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const OPEN_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
