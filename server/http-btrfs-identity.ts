export interface BtrfsIdentity {
  readonly fileSystemId: string;
  readonly rootId: string;
}

const BTRFS_INO_LOOKUP_BYTES = 4_096;
const BTRFS_IOC_INO_LOOKUP = 0xd000_9412n;
const BTRFS_FIRST_FREE_OBJECTID = 256n;
const BTRFS_FS_INFO_BYTES = 1_024;
const BTRFS_IOC_FS_INFO = 0x8400_941fn;

export type BtrfsIoctl = (
  fileDescriptor: number,
  request: bigint,
  argument: Buffer
) => number;

interface BtrfsIdentityImplementation {
  readBtrfsIdentity(
    fileDescriptor: number,
    canonicalPath: string
  ): Promise<BtrfsIdentity>;
}

/**
 * The standalone runtime uses its bundled FFI. The Node adapter supports the
 * root test runtime and source-only server invocations.
 */
export async function readBtrfsIdentity(
  fileDescriptor: number,
  canonicalPath: string
): Promise<BtrfsIdentity> {
  const implementation: BtrfsIdentityImplementation =
    process.versions.bun === undefined
      ? await import("./http-btrfs-identity-node.js")
      : await import("./http-btrfs-identity-bun.js");
  return await implementation.readBtrfsIdentity(
    fileDescriptor,
    canonicalPath
  );
}

/** Execute and decode the fixed Linux Btrfs identity ABIs. */
export function readBtrfsIdentityWithIoctl(
  fileDescriptor: number,
  canonicalPath: string,
  ioctl: BtrfsIoctl
): BtrfsIdentity {
  const inodeLookup = Buffer.alloc(BTRFS_INO_LOOKUP_BYTES);
  inodeLookup.writeBigUInt64LE(BTRFS_FIRST_FREE_OBJECTID, 8);
  if (ioctl(fileDescriptor, BTRFS_IOC_INO_LOOKUP, inodeLookup) !== 0) {
    throw btrfsIdentityError(canonicalPath);
  }
  const rootId = inodeLookup.readBigUInt64LE(0);
  const fileSystemInfo = Buffer.alloc(BTRFS_FS_INFO_BYTES);
  if (rootId === 0n
    || ioctl(fileDescriptor, BTRFS_IOC_FS_INFO, fileSystemInfo) !== 0) {
    throw btrfsIdentityError(canonicalPath);
  }
  const fileSystemId = fileSystemInfo.subarray(16, 32).toString("hex");
  if (/^0{32}$/.test(fileSystemId)) {
    throw btrfsIdentityError(canonicalPath);
  }
  return Object.freeze({
    fileSystemId,
    rootId: rootId.toString(10)
  });
}

function btrfsIdentityError(canonicalPath: string): Error {
  return new Error(
    `1667 cannot identify the Btrfs filesystem for ${canonicalPath}`
  );
}
