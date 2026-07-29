import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";
import {
  readLinuxFileHandleWithCall
} from "./linux-file-handle.js";

export async function readLinuxFileHandle(
  fileDescriptor: number,
  canonicalPath: string
): Promise<string | null> {
  const ffi = await loadBunFfi();
  const library = openPosixLibc(ffi, {
    name_to_handle_at: {
      args: ["i32", "ptr", "ptr", "ptr", "i32"],
      returns: "i32"
    }
  });
  try {
    const emptyPath = Buffer.from([0]);
    return readLinuxFileHandleWithCall(
      fileDescriptor,
      canonicalPath,
      (descriptor, handle, mountId, flags) =>
        Number(library.symbols.name_to_handle_at!(
          descriptor,
          ffi.ptr(emptyPath),
          ffi.ptr(handle),
          ffi.ptr(mountId),
          flags
        ))
    );
  } finally {
    library.close();
  }
}
