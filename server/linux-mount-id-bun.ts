import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";
import {
  decodeLinuxUniqueMountId,
  linuxStatxSyscallNumber,
  LINUX_STATX_MOUNT_ID_MASK,
  statxMountIdBuffer
} from "./linux-mount-id.js";

const AT_EMPTY_PATH = 0x1000;

export async function readLinuxUniqueMountId(
  fileDescriptor: number,
  canonicalPath: string
): Promise<string> {
  const ffi = await loadBunFfi();
  const library = openPosixLibc(ffi, {
    syscall: {
      args: ["i64", "i32", "ptr", "i32", "u32", "ptr"],
      returns: "i64"
    }
  });
  try {
    const emptyPath = Buffer.from([0]);
    const statx = statxMountIdBuffer();
    const result = Number(library.symbols.syscall!(
      linuxStatxSyscallNumber(process.arch),
      fileDescriptor,
      ffi.ptr(emptyPath),
      AT_EMPTY_PATH,
      LINUX_STATX_MOUNT_ID_MASK,
      ffi.ptr(statx)
    ));
    return decodeLinuxUniqueMountId(result, statx, canonicalPath);
  } finally {
    library.close();
  }
}
