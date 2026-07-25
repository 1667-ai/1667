import { constants } from "node:fs";

const LINUX_RETAINED_DIRECTORY = /^\/proc\/self\/fd\/([0-9]+)$/;
const DARWIN_RETAINED_DIRECTORY = /^\/dev\/fd\/([0-9]+)$/;

/**
 * Internal retained-directory roots are kernel-owned links to a descriptor
 * already held by this process. User-configured paths are rejected before a
 * lease can produce this representation.
 */
export function isRetainedDirectoryAuthorityPath(value: string): boolean {
  if (process.platform === "linux") return LINUX_RETAINED_DIRECTORY.test(value);
  if (process.platform === "darwin") return DARWIN_RETAINED_DIRECTORY.test(value);
  return false;
}

export function retainedDirectoryOpenFlags(): number {
  const directory = typeof constants.O_DIRECTORY === "number"
    ? constants.O_DIRECTORY
    : 0;
  return constants.O_RDONLY | directory;
}
