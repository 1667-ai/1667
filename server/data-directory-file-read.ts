import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import {
  assertNoDarwinExtendedAllow
} from "./storage-privacy-darwin.js";

export interface BoundedRegularFileOptions {
  readonly requirePrivate?: boolean;
  /** Historical writers used 0666 filtered by the caller's umask. The
   * enclosing data root must already be private before admitting that mode. */
  readonly allowLegacyOwnerReadMode?: boolean;
  readonly allowedLinkCounts?: readonly number[];
}

export interface MutableAuthorityFileOptions {
  readonly requirePrivate?: boolean;
}

/** Stable no-follow snapshot for a reserved file beneath an already-resolved root. */
export async function readBoundedRegularFile(
  file: string,
  maxBytes: number,
  options: BoundedRegularFileOptions = {}
): Promise<Buffer> {
  const policy = {
    ...options,
    requirePrivate: options.requirePrivate ?? false,
    allowedLinkCounts: options.allowedLinkCounts ?? [1]
  };
  let handle: FileHandle | undefined;
  try {
    const pathInfo = await lstat(file);
    requireBoundedRegularFile(pathInfo, file, maxBytes, policy);
    if (policy.requirePrivate) {
      await assertNoDarwinExtendedAllow(file, "private data file");
    }
    handle = await open(file, constants.O_RDONLY | noFollowFlag());
    const before = await handle.stat();
    requireBoundedRegularFile(before, file, maxBytes, policy);
    requireSameFileIdentity(pathInfo, before, file);

    const bytes = Buffer.alloc(Number(before.size) + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }

    const after = await handle.stat();
    requireBoundedRegularFile(after, file, maxBytes, policy);
    if (
      total !== Number(before.size)
      || !sameFileSnapshot(before, after)
    ) {
      throw new Error(`Reserved data-directory file changed while being read: ${file}`);
    }
    const finalPathInfo = await lstat(file);
    requireBoundedRegularFile(finalPathInfo, file, maxBytes, policy);
    requireSameFileIdentity(after, finalPathInfo, file);
    return bytes.subarray(0, total);
  } finally {
    await handle?.close();
  }
}

/**
 * Read an authoritative file whose pathname is replaced atomically.
 *
 * Unlike immutable markers and receipts, a valid rename may unlink the opened
 * inode while it is being read. The entry must still resolve to the opened
 * regular file initially; a replacement between lstat and open is retried.
 * Once opened, either the linked snapshot or its exact unlink transition is a
 * valid authority snapshot.
 */
export async function readBoundedMutableAuthorityFile(
  file: string,
  maxBytes: number,
  options: MutableAuthorityFileOptions = {}
): Promise<Buffer> {
  const linkedPolicy = {
    requirePrivate: options.requirePrivate ?? false,
    allowedLinkCounts: [1]
  } as const;
  const openedPolicy = {
    requirePrivate: options.requirePrivate ?? false,
    allowedLinkCounts: [0, 1]
  } as const;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      const pathInfo = await lstat(file);
      requireBoundedRegularFile(pathInfo, file, maxBytes, linkedPolicy);
      if (linkedPolicy.requirePrivate) {
        await assertNoDarwinExtendedAllow(file, "private data authority");
      }
      handle = await open(file, constants.O_RDONLY | noFollowFlag());
      const before = await handle.stat();
      requireBoundedRegularFile(before, file, maxBytes, openedPolicy);
      if (!sameFileIdentity(pathInfo, before)) continue;

      const bytes = Buffer.alloc(Number(before.size) + 1);
      let total = 0;
      while (total < bytes.length) {
        const result = await handle.read(bytes, total, bytes.length - total, total);
        if (result.bytesRead === 0) break;
        total += result.bytesRead;
      }

      const after = await handle.stat();
      requireBoundedRegularFile(after, file, maxBytes, openedPolicy);
      if (
        total !== Number(before.size)
        || !sameMutableAuthoritySnapshot(before, after)
      ) {
        throw new Error(`Mutable data-directory authority changed while being read: ${file}`);
      }
      if (Number(after.nlink) === 0) {
        await requireDistinctLinkedReplacement(
          file,
          after,
          maxBytes,
          linkedPolicy
        );
      }
      return bytes.subarray(0, total);
    } finally {
      await handle?.close();
    }
  }

  throw new Error(
    `Mutable data-directory authority was repeatedly replaced while being opened: ${file}`
  );
}

export function requireBoundedRegularFile(
  info: Stats,
  file: string,
  maxBytes: number,
  options: BoundedRegularFileOptions = {}
): void {
  const requirePrivate = options.requirePrivate ?? false;
  const allowedLinkCounts = options.allowedLinkCounts ?? [1];
  if (!info.isFile() || info.isSymbolicLink() || Number(info.size) > maxBytes) {
    throw new Error(`Reserved data-directory path is not a bounded regular file: ${file}`);
  }
  if (
    process.platform !== "win32"
    && !allowedLinkCounts.includes(Number(info.nlink))
  ) {
    throw new Error(`Reserved data-directory file has an unsafe link count: ${file}`);
  }
  if (process.platform !== "win32" && (requirePrivate || options.allowLegacyOwnerReadMode === true)) {
    const mode = Number(info.mode) & 0o777;
    const legacyOwnerReadable = (mode & 0o400) !== 0 && (mode & ~0o666) === 0;
    if (
      (requirePrivate && mode !== 0o600)
      || (!requirePrivate && !legacyOwnerReadable)
    ) {
      throw new Error(`Reserved data-directory file permissions are unsafe: ${file}`);
    }
    if (
      typeof process.geteuid === "function"
      && Number(info.uid) !== process.geteuid()
    ) {
      throw new Error(`Reserved data-directory file owner is unsafe: ${file}`);
    }
  }
}

export function requireSameFileIdentity(
  left: Stats,
  right: Stats,
  file: string
): void {
  if (!sameFileIdentity(left, right)) {
    throw new Error(`Reserved data-directory file identity changed: ${file}`);
  }
}

export function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameFileSnapshot(
  left: Stats,
  right: Stats
): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameMutableAuthoritySnapshot(left: Stats, right: Stats): boolean {
  if (sameFileSnapshot(left, right)) return true;
  return sameFileIdentity(left, right)
    && Number(left.nlink) === 1
    && Number(right.nlink) === 0
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs
    && right.ctimeMs >= left.ctimeMs;
}

async function requireDistinctLinkedReplacement(
  file: string,
  unlinked: Stats,
  maxBytes: number,
  policy: BoundedRegularFileOptions
): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      const pathInfo = await lstat(file);
      requireBoundedRegularFile(pathInfo, file, maxBytes, policy);
      if (sameFileIdentity(unlinked, pathInfo)) {
        throw new Error(
          `Mutable data-directory authority was unlinked without a distinct replacement: ${file}`
        );
      }
      handle = await open(file, constants.O_RDONLY | noFollowFlag());
      const handleInfo = await handle.stat();
      requireBoundedRegularFile(handleInfo, file, maxBytes, policy);
      if (!sameFileIdentity(pathInfo, handleInfo)) continue;
      if (sameFileIdentity(unlinked, handleInfo)) {
        throw new Error(
          `Mutable data-directory authority was unlinked without a distinct replacement: ${file}`
        );
      }
      return;
    } finally {
      await handle?.close();
    }
  }

  throw new Error(
    `Mutable data-directory authority replacement was repeatedly replaced while being opened: ${file}`
  );
}

export function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}
