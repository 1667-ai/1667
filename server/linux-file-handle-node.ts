import {
  readLinuxFileHandleWithCall
} from "./linux-file-handle.js";
import { loadNodePosixLibc } from "./posix-libc-node.js";

export async function readLinuxFileHandle(
  fileDescriptor: number,
  canonicalPath: string
): Promise<string | null> {
  const library = loadNodePosixLibc(
    "name_to_handle_at",
    "1667 cannot load the Linux file-handle interface"
  );
  try {
    const nameToHandleAt = library.func(
      "name_to_handle_at",
      "int",
      ["int", "str", "void *", "void *", "int"]
    );
    return readLinuxFileHandleWithCall(
      fileDescriptor,
      canonicalPath,
      (descriptor, handle, mountId, flags) => Number(nameToHandleAt(
        descriptor,
        "",
        handle,
        mountId,
        flags
      ))
    );
  } finally {
    library.unload();
  }
}
