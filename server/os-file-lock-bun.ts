import { loadBunFfi, openPosixLibc, type BunFfi } from "./bun-ffi.js";

const LOCK_EXCLUSIVE_NONBLOCKING = 6;
const LOCK_UN = 8;
const WINDOWS_LOCK_EXCLUSIVE_IMMEDIATE = 3;
const WHOLE_FILE = 0xffff_ffff;

export async function lockFile(fd: number): Promise<void> {
  const ffi = await loadBunFfi();
  const acquired = process.platform === "win32" ? lockWindows(ffi, fd, true) : lockPosix(ffi, fd, true);
  if (!acquired) throw lockError();
}

export async function unlockFile(fd: number): Promise<void> {
  const ffi = await loadBunFfi();
  const released = process.platform === "win32" ? lockWindows(ffi, fd, false) : lockPosix(ffi, fd, false);
  if (!released) throw new Error("Failed to release 1667 data-directory lock");
}

function lockPosix(ffi: BunFfi, fd: number, acquire: boolean): boolean {
  const library = openPosixLibc(ffi, { flock: { args: ["i32", "i32"], returns: "i32" } });
  try {
    return library.symbols.flock!(fd, acquire ? LOCK_EXCLUSIVE_NONBLOCKING : LOCK_UN) === 0;
  } finally {
    library.close();
  }
}

function lockWindows(ffi: BunFfi, fd: number, acquire: boolean): boolean {
  const crt = ffi.dlopen("ucrtbase.dll", { _get_osfhandle: { args: ["i32"], returns: "i64" } });
  const kernel = ffi.dlopen("kernel32.dll", acquire
    ? { LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" } }
    : { UnlockFileEx: { args: ["u64", "u32", "u32", "u32", "ptr"], returns: "i32" } });
  try {
    const handle = crt.symbols._get_osfhandle!(fd);
    const overlapped = ffi.ptr(new Uint8Array(32));
    const result = acquire
      ? kernel.symbols.LockFileEx!(handle, WINDOWS_LOCK_EXCLUSIVE_IMMEDIATE, 0, WHOLE_FILE, WHOLE_FILE, overlapped)
      : kernel.symbols.UnlockFileEx!(handle, 0, WHOLE_FILE, WHOLE_FILE, overlapped);
    return result !== 0;
  } finally {
    kernel.close();
    crt.close();
  }
}

function lockError(): Error & { code: string } {
  return Object.assign(new Error("1667 data directory is locked"), { code: "ELOCKED" });
}
