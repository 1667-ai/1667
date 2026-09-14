import { createRequire } from "node:module";
import { getSystemErrorName } from "node:util";
import { openPosixLibc } from "./bun-ffi.js";
import { loadNodeFfi } from "./node-ffi.js";
import type { OsFileLockMode } from "./os-file-lock.js";

const WHOLE_FILE = 0xffff_ffff;
const WINDOWS_LOCK_EXCLUSIVE_IMMEDIATE = 3;
const WINDOWS_LOCK_SHARED_IMMEDIATE = 1;
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
  if (process.platform === "win32") {
    throw new Error("Node Windows file locks require a path");
  }
  const ffi = loadNodeFfi();
  const libc = openPosixLibc(ffi, {
    flock: { args: ["i32", "i32"], returns: "i32" }
  });
  try {
    const result = Number(libc.symbols.flock!(
      fd,
      mode === "exclusive" ? 6 : 5
    ));
    if (result !== 0) throw posixError("acquire", currentErrno());
  } finally {
    libc.close();
  }
}

export async function unlockFile(fd: number): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("Node Windows file locks require a path");
  }
  const ffi = loadNodeFfi();
  const libc = openPosixLibc(ffi, {
    flock: { args: ["i32", "i32"], returns: "i32" }
  });
  try {
    const result = Number(libc.symbols.flock!(fd, 8));
    if (result !== 0) {
      throw posixError("release", currentErrno());
    }
  } finally {
    libc.close();
  }
}

/**
 * Node file descriptors do not map to Windows HANDLE values. Keep the native
 * handle and OVERLAPPED value until the returned lock is released.
 */
export async function lockWindowsFile(
  file: string,
  mode: OsFileLockMode
): Promise<{ unlock(): Promise<void> }> {
  const ffi = loadNodeFfi();
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
    FILE_READ_DATA | FILE_WRITE_DATA,
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

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function lockError(): Error & { code: string } {
  return Object.assign(new Error("1667 data directory is locked"), { code: "ELOCKED" });
}

function posixError(operation: string, value: number): Error & { code: string } {
  const code = systemErrorName(value);
  if (isContentionCode(code)) {
    return Object.assign(lockError(), { errno: value });
  }
  return Object.assign(
    new Error(`Failed to ${operation} the 1667 data-directory lock (${code})`),
    { code, errno: value }
  );
}

function systemErrorName(value: number): string {
  try {
    return getSystemErrorName(-value);
  } catch {
    return `ERRNO_${value}`;
  }
}

function currentErrno(): number {
  const { errno } = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  return errno();
}

function isContentionCode(code: string): boolean {
  return code === "EACCES"
    || code === "EAGAIN"
    || code === "EBUSY"
    || code === "EWOULDBLOCK";
}

function windowsError(operation: string, code: number): Error & { code: string } {
  return Object.assign(
    new Error(`Failed to ${operation} the Windows file lock (${code})`),
    { code: "EIO" }
  );
}
