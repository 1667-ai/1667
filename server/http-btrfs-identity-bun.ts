import { loadBunFfi, openPosixLibc } from "./bun-ffi.js";
import {
  readBtrfsIdentityWithIoctl,
  type BtrfsIdentity
} from "./http-btrfs-identity.js";

/** Read the filesystem and subvolume IDs through the retained descriptor. */
export async function readBtrfsIdentity(
  fileDescriptor: number,
  canonicalPath: string
): Promise<BtrfsIdentity> {
  const ffi = await loadBunFfi();
  const library = openPosixLibc(ffi, {
    ioctl: { args: ["i32", "u64", "ptr"], returns: "i32" }
  });
  try {
    return readBtrfsIdentityWithIoctl(
      fileDescriptor,
      canonicalPath,
      (descriptor, request, argument) => Number(library.symbols.ioctl!(
        descriptor,
        request,
        ffi.ptr(argument)
      ))
    );
  } finally {
    library.close();
  }
}
