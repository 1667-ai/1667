import {
  decodeLinuxUniqueMountId,
  linuxStatxSyscallNumber,
  LINUX_STATX_MOUNT_ID_MASK,
  statxMountIdBuffer
} from "./linux-mount-id.js";
import { loadNodePosixLibc } from "./posix-libc-node.js";

const AT_EMPTY_PATH = 0x1000;

type StatxCall = (
  fileDescriptor: number,
  path: string,
  flags: number,
  mask: number,
  output: Buffer
) => number;

let statxCall: StatxCall | undefined;

export async function readLinuxUniqueMountId(
  fileDescriptor: number,
  canonicalPath: string
): Promise<string> {
  const statx = statxMountIdBuffer();
  const result = nodeStatxCall()(
    fileDescriptor,
    "",
    AT_EMPTY_PATH,
    LINUX_STATX_MOUNT_ID_MASK,
    statx
  );
  return decodeLinuxUniqueMountId(result, statx, canonicalPath);
}

function nodeStatxCall(): StatxCall {
  if (statxCall !== undefined) return statxCall;
  try {
    const library = loadNodePosixLibc(
      "statx",
      "1667 cannot load the Linux statx interface"
    );
    const call = library.func(
      "statx",
      "int",
      ["int", "str", "int", "uint", "void *"]
    );
    statxCall = (fileDescriptor, path, flags, mask, output) =>
      Number(call(fileDescriptor, path, flags, mask, output));
    return statxCall;
  } catch {
    const library = loadNodePosixLibc(
      "syscall",
      "1667 cannot load the Linux statx interface"
    );
    const syscall = library.func("syscall", "long", ["long", "..."]);
    statxCall = (fileDescriptor, path, flags, mask, output) => Number(
      syscall(
        linuxStatxSyscallNumber(process.arch),
        "int",
        fileDescriptor,
        "str",
        path,
        "int",
        flags,
        "uint",
        mask,
        "void *",
        output
      )
    );
    return statxCall;
  }
}
