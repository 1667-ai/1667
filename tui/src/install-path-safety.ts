import {
  constants as fsConstants,
  statSync,
  type Stats
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { groupOtherMembers } from "./install-path-group.js";

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
 * that an earlier `sudo` left owned by root. They do not protect against a
 * program that already runs as the current user, because such a program can
 * write to the Install Root whatever its mode is.
 *
 * They do refuse a path that a *different* account can write, because 1667
 * stages a candidate in the Install Root, verifies its digest, runs it once,
 * and then renames it into place. Another account that can write there can
 * replace the candidate inside that window, and the reader then runs bytes that
 * no check saw.
 *
 * Writable to everybody always fails. Writable to a group fails only when the
 * group holds somebody besides this user, because Ubuntu gives each user a
 * private group and Homebrew's `admin` group holds root and the owner. Reading
 * the bit alone refused those layouts while naming no exposure at all.
 */
export function assertSafeOwnedPath(
  value: string,
  options: {
    readonly label: string;
    readonly requireFile?: boolean;
    readonly requireDirectory?: boolean;
    readonly allowMissing?: boolean;
    readonly expectedModeMask?: number;
    /**
     * Accept a path another account can write. `--force` sets this. A reader
     * who has looked at the directory and decided may proceed; nothing else
     * about a release is waived by it.
     */
    readonly force?: boolean;
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
  if (options.force !== true) {
    assertOwner(stats, options.label, value);
    assertNoOtherWriter(stats, options.label, value);
  }
  // An exact mode still applies to a file 1667 writes itself, such as the
  // Ownership Record at 0600. That check reads 1667's own work, and refuses no
  // layout that a person chose.
  if (options.expectedModeMask !== undefined
    && (stats.mode & 0o777) !== options.expectedModeMask) {
    throw new Error(`${options.label} has an unsafe mode`);
  }
  return Object.freeze({ path: value, stats });
}

export function assertSafeInstallRoot(installRoot: string, force = false): void {
  assertSafeOwnedPath(installRoot, {
    label: "Install Root",
    requireDirectory: true,
    force
  });
}

/** `755`, the form a reader types back into chmod. */
function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "you";
  }
}

function assertOwner(stats: Stats, label: string, file: string): void {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined) throw new Error(`${label} requires POSIX user identity`);
  if (stats.uid === uid) return;
  const user = currentUser();
  throw new Error(
    `${label} ${file} belongs to user ${stats.uid}, and you are ${user}. `
    + "1667 replaces files there during an upgrade, which it cannot do as "
    + `another user. Run: sudo chown ${user} ${file} — choose another `
    + "Install Root, or pass --force to use it anyway."
  );
}

/**
 * Refuse a path that an account other than this one can write. The message
 * names the bit, the mode, and the accounts, so a reader can act on it without
 * running `stat` and `getent` to find out what 1667 objected to.
 */
function assertNoOtherWriter(stats: Stats, label: string, file: string): void {
  const mode = octal(stats.mode);
  if ((stats.mode & 0o002) !== 0) {
    throw new Error(
      `${label} ${file} is writable by every account on this machine `
      + `(mode ${mode}). Any of them could replace what 1667 installs there. `
      + `Run: chmod o-w ${file} — or pass --force to use it anyway.`
    );
  }
  if ((stats.mode & 0o020) === 0) return;
  const user = currentUser();
  const group = groupOtherMembers(stats.gid, user);
  if (group === null) {
    throw new Error(
      `${label} ${file} is writable by group ${stats.gid} (mode ${mode}), and `
      + "1667 could not read that group's members to see whether anybody else "
      + `is in it. Run: chmod g-w ${file} — or pass --force to use it anyway.`
    );
  }
  if (group.others.length === 0) return;
  const name = group.name ?? String(stats.gid);
  throw new Error(
    `${label} ${file} is writable by group ${name} (mode ${mode}), which also `
    + `holds ${group.others.join(", ")}. That account could replace what 1667 `
    + `installs there. Run: chmod g-w ${file} — choose another Install Root, `
    + "or pass --force to use it anyway."
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const OPEN_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
