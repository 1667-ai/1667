import {
  readBtrfsIdentityWithIoctl,
  type BtrfsIdentity
} from "./http-btrfs-identity.js";
import { loadNodePosixLibc } from "./posix-libc-node.js";

/** Read the filesystem and subvolume IDs through the retained descriptor. */
export async function readBtrfsIdentity(
  fileDescriptor: number,
  canonicalPath: string
): Promise<BtrfsIdentity> {
  const library = loadNodePosixLibc(
    "ioctl",
    "1667 cannot load the Linux Btrfs interface"
  );
  try {
    const ioctl = library.func(
      "ioctl",
      "int",
      ["int", "ulong", "void *"]
    );
    return readBtrfsIdentityWithIoctl(
      fileDescriptor,
      canonicalPath,
      (descriptor, request, argument) =>
        Number(ioctl(descriptor, request, argument))
    );
  } finally {
    library.unload();
  }
}
