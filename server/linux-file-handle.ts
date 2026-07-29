const LINUX_FILE_HANDLE_MAX_BYTES = 128;
const LINUX_FILE_HANDLE_HEADER_BYTES = 8;
const AT_HANDLE_FID = 0x200;
const AT_EMPTY_PATH = 0x1000;
export const LINUX_IDENTITY_HANDLE_FLAGS = AT_HANDLE_FID | AT_EMPTY_PATH;

interface LinuxFileHandleImplementation {
  readLinuxFileHandle(
    fileDescriptor: number,
    canonicalPath: string
  ): Promise<string | null>;
}

export type NameToHandleAtCall = (
  fileDescriptor: number,
  handle: Buffer,
  mountId: Buffer,
  flags: number
) => number;

export async function readLinuxFileHandle(
  fileDescriptor: number,
  canonicalPath: string
): Promise<string | null> {
  try {
    const implementation: LinuxFileHandleImplementation =
      process.versions.bun === undefined
        ? await import("./linux-file-handle-node.js")
        : await import("./linux-file-handle-bun.js");
    return await implementation.readLinuxFileHandle(
      fileDescriptor,
      canonicalPath
    );
  } catch {
    // A null result makes the caller reject the unsupported filesystem.
    return null;
  }
}

export function readLinuxFileHandleWithCall(
  fileDescriptor: number,
  canonicalPath: string,
  call: NameToHandleAtCall
): string | null {
  const handle = Buffer.alloc(
    LINUX_FILE_HANDLE_HEADER_BYTES + LINUX_FILE_HANDLE_MAX_BYTES
  );
  handle.writeUInt32LE(LINUX_FILE_HANDLE_MAX_BYTES, 0);
  const result = call(
    fileDescriptor,
    handle,
    Buffer.alloc(4),
    LINUX_IDENTITY_HANDLE_FLAGS
  );
  const byteLength = handle.readUInt32LE(0);
  const type = handle.readInt32LE(4);
  if (result !== 0) return null;
  if (byteLength === 0
    || byteLength > LINUX_FILE_HANDLE_MAX_BYTES
    || type <= 0) {
    throw new Error(
      `1667 cannot identify a durable Linux file handle for ${canonicalPath}`
    );
  }
  return `${type}:${handle.subarray(
    LINUX_FILE_HANDLE_HEADER_BYTES,
    LINUX_FILE_HANDLE_HEADER_BYTES + byteLength
  ).toString("hex")}`;
}
