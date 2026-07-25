import { ServiceError } from "./errors.js";

// Conservative allowlist: these local filesystems have process-shared advisory
// locking semantics on the corresponding platform. Unknown/network mounts are
// refused rather than risking two authoritative writers.
const DARWIN_LOCAL_FILESYSTEMS = new Set(["apfs", "hfs"]);
const LINUX_LOCAL_FILESYSTEMS = new Set([
  0xef53n, // ext2/3/4
  0x58465342n, // XFS
  0x9123683en, // Btrfs
  0x01021994n, // tmpfs
  0x794c7630n, // overlayfs
  0x2fc12fc1n, // ZFS
  0xf2f52010n, // F2FS
  0x3153464an, // JFS
  0x24051905n, // UBIFS
  0x52654973n // ReiserFS
]);
const WINDOWS_LOCAL_DRIVE_TYPES = new Set([
  2n, // removable
  3n, // fixed
  6n // RAM disk
]);

export async function assertSupportedDataFilesystem(directory: string): Promise<void> {
  if (process.platform === "win32") {
    if (isUncPath(directory)) throw unsupportedFilesystem();
  }
  let info: FilesystemInfo;
  try {
    info = process.platform === "win32"
      ? await (await import("./storage-filesystem-windows.js")).filesystemInfo(directory)
      : process.versions.bun === undefined
        ? await (await import("./storage-filesystem-node.js")).filesystemInfo(directory)
        : await (await import("./storage-filesystem-bun.js")).filesystemInfo(directory);
  } catch {
    throw unsupportedFilesystem();
  }
  const supported = isVerifiedLocalFilesystem(process.platform, info);
  if (!supported) throw unsupportedFilesystem();
}

export interface FilesystemInfo {
  type: bigint;
  typeName?: string;
  local?: boolean;
}

export function isVerifiedLocalFilesystem(platform: NodeJS.Platform, info: FilesystemInfo): boolean {
  if (platform === "win32") return WINDOWS_LOCAL_DRIVE_TYPES.has(info.type);
  if (platform === "darwin") {
    return DARWIN_LOCAL_FILESYSTEMS.has(info.typeName?.toLowerCase() ?? "") && info.local !== false;
  }
  if (platform === "linux") return LINUX_LOCAL_FILESYSTEMS.has(info.type);
  return false;
}

function isUncPath(directory: string): boolean {
  return directory.startsWith("\\\\") || directory.startsWith("//");
}

function unsupportedFilesystem(): ServiceError {
  return new ServiceError(
    422,
    "1667 data must be on a verified local filesystem; network and unknown filesystems are not supported."
  );
}
