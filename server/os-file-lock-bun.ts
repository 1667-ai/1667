import { loadBunFfi, openPosixLibc, type BunFfi } from "./bun-ffi.js";
import type { OsFileLockMode } from "./os-file-lock.js";

const LOCK_EXCLUSIVE_NONBLOCKING = 6;
const LOCK_SHARED_NONBLOCKING = 5;
const LOCK_UN = 8;
const WINDOWS_LOCK_EXCLUSIVE_IMMEDIATE = 3;
const WINDOWS_LOCK_SHARED_IMMEDIATE = 1;
const WHOLE_FILE = 0xffff_ffff;
const FILE_READ_DATA = 0x0000_0001;
const FILE_WRITE_DATA = 0x0000_0002;
const FILE_SHARE_ALL = 0x0000_0007;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x0000_0080;
const ERROR_LOCK_VIOLATION = 33;
const INVALID_HANDLE_VALUE = -1n;

export async function lockFile(
  fd: number,
  mode: OsFileLockMode
): Promise<void> {
  const ffi = await loadBunFfi();
  const acquired = lockPosix(ffi, fd, mode);
  if (!acquired) throw lockError();
}

export async function unlockFile(fd: number): Promise<void> {
  const ffi = await loadBunFfi();
  const released = unlockPosix(ffi, fd);
  if (!released) throw new Error("Failed to release 1667 data-directory lock");
}

/**
 * Bun file descriptors do not belong to the Windows C runtime. Open and keep a
 * native handle so LockFileEx and UnlockFileEx use the same OVERLAPPED value.
 */
export async function lockWindowsFile(
  file: string,
  mode: OsFileLockMode
): Promise<{ unlock(): Promise<void> }> {
  const ffi = await loadBunFfi();
  const kernel = ffi.dlopen("kernel32.dll", {
    CloseHandle: { args: ["i64"], returns: "i32" },
    CreateFileW: {
      args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "i64"],
      returns: "i64"
    },
    GetLastError: { args: [], returns: "u32" },
    LockFileEx: {
      args: ["i64", "u32", "u32", "u32", "u32", "ptr"],
      returns: "i32"
    },
    UnlockFileEx: {
      args: ["i64", "u32", "u32", "u32", "ptr"],
      returns: "i32"
    }
  });
  const fileName = wideString(file);
  const overlapped = new BigUint64Array(4);
  const handle = kernel.symbols.CreateFileW!(
    ffi.ptr(fileName),
    FILE_READ_DATA + FILE_WRITE_DATA,
    FILE_SHARE_ALL,
    0,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    0
  );
  if (BigInt(handle) === INVALID_HANDLE_VALUE) {
    const code = Number(kernel.symbols.GetLastError!());
    kernel.close();
    throw windowsError("open", code);
  }

  const acquired = kernel.symbols.LockFileEx!(
    handle,
    mode === "exclusive"
      ? WINDOWS_LOCK_EXCLUSIVE_IMMEDIATE
      : WINDOWS_LOCK_SHARED_IMMEDIATE,
    0,
    WHOLE_FILE,
    WHOLE_FILE,
    ffi.ptr(new Uint8Array(
      overlapped.buffer,
      overlapped.byteOffset,
      overlapped.byteLength
    ))
  );
  if (acquired === 0) {
    const code = Number(kernel.symbols.GetLastError!());
    kernel.symbols.CloseHandle!(handle);
    kernel.close();
    if (code === ERROR_LOCK_VIOLATION) throw lockError();
    throw windowsError("acquire", code);
  }

  let released = false;
  return {
    unlock: async () => {
      if (released) return;
      released = true;
      try {
        const result = kernel.symbols.UnlockFileEx!(
          handle,
          0,
          WHOLE_FILE,
          WHOLE_FILE,
          ffi.ptr(new Uint8Array(
            overlapped.buffer,
            overlapped.byteOffset,
            overlapped.byteLength
          ))
        );
        if (result === 0) {
          const code = Number(kernel.symbols.GetLastError!());
          throw windowsError("release", code);
        }
      } finally {
        kernel.symbols.CloseHandle!(handle);
        kernel.close();
      }
    }
  };
}

function lockPosix(
  ffi: BunFfi,
  fd: number,
  mode: OsFileLockMode
): boolean {
  const library = openPosixLibc(ffi, { flock: { args: ["i32", "i32"], returns: "i32" } });
  try {
    return library.symbols.flock!(
      fd,
      mode === "exclusive"
        ? LOCK_EXCLUSIVE_NONBLOCKING
        : LOCK_SHARED_NONBLOCKING
    ) === 0;
  } finally {
    library.close();
  }
}

function unlockPosix(ffi: BunFfi, fd: number): boolean {
  const library = openPosixLibc(ffi, { flock: { args: ["i32", "i32"], returns: "i32" } });
  try {
    return library.symbols.flock!(fd, LOCK_UN) === 0;
  } finally {
    library.close();
  }
}

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function lockError(): Error & { code: string } {
  return Object.assign(new Error("1667 data directory is locked"), { code: "ELOCKED" });
}

function windowsError(operation: string, code: number): Error & { code: string } {
  return Object.assign(
    new Error(`Failed to ${operation} the Windows file lock (${code})`),
    { code: "EIO" }
  );
}
