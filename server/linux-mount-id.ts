const STATX_MNT_ID_UNIQUE = 0x0000_4000;
const STATX_BYTES = 256;
const STATX_MASK_OFFSET = 0x00;
const STATX_MOUNT_ID_OFFSET = 0x90;

interface LinuxMountIdImplementation {
  readLinuxUniqueMountId(
    fileDescriptor: number,
    canonicalPath: string
  ): Promise<string>;
}

export async function readLinuxUniqueMountId(
  fileDescriptor: number,
  canonicalPath: string
): Promise<string> {
  const implementation: LinuxMountIdImplementation =
    process.versions.bun === undefined
      ? await import("./linux-mount-id-node.js")
      : await import("./linux-mount-id-bun.js");
  return await implementation.readLinuxUniqueMountId(
    fileDescriptor,
    canonicalPath
  );
}

export function statxMountIdBuffer(): Buffer {
  return Buffer.alloc(STATX_BYTES);
}

export function decodeLinuxUniqueMountId(
  result: number,
  statx: Buffer,
  canonicalPath: string
): string {
  const mask = statx.readUInt32LE(STATX_MASK_OFFSET);
  const mountId = statx.readBigUInt64LE(STATX_MOUNT_ID_OFFSET);
  if (result !== 0
    || (mask & STATX_MNT_ID_UNIQUE) === 0
    || mountId === 0n) {
    throw new Error(
      `1667 cannot identify the Linux mount generation for ${canonicalPath}`
    );
  }
  return mountId.toString(10);
}

export const LINUX_STATX_MOUNT_ID_MASK = STATX_MNT_ID_UNIQUE;

export function linuxStatxSyscallNumber(arch: string): bigint {
  if (arch === "x64") return 332n;
  if (arch === "arm64") return 291n;
  throw new Error(
    `1667 cannot query Linux mount identity on architecture ${arch}`
  );
}
