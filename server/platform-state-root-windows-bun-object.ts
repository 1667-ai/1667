import type {
  BunFfi
} from "./bun-ffi.js";
import {
  closeWindowsHandle,
  lastWindowsError,
  type NativeHandle,
  type WindowsLibraries
} from "./platform-state-root-windows-bun-api.js";
import type {
  WindowsPrivateObjectKind
} from "./platform-state-root-windows-bun-security.js";

const FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
export const FILE_READ_ATTRIBUTES = 0x0000_0080;
export const READ_CONTROL = 0x0002_0000;
const FILE_SHARE_READ = 0x0000_0001;
const FILE_SHARE_WRITE = 0x0000_0002;
export const FILE_SHARE_ALL = 0x0000_0007;
export const FILE_SHARE_REPAIR = FILE_SHARE_READ | FILE_SHARE_WRITE;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
const INVALID_HANDLE_VALUE = -1n;

export interface WindowsDirectorySnapshot {
  readonly directory: string;
  readonly identity: Buffer;
}

export function openWindowsPrivateStateObject(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string,
  access: number,
  kind: WindowsPrivateObjectKind,
  share: number
): NativeHandle {
  const encoded = wideWindowsString(target);
  try {
    const handle = libraries.kernel.symbols.CreateFileW!(
      ffi.ptr(encoded),
      access,
      share,
      0,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      0
    );
    if (BigInt(handle) === INVALID_HANDLE_VALUE) {
      throw lastWindowsError(libraries, `Could not open ${target}`);
    }
    const tag = Buffer.alloc(8);
    if (Number(libraries.kernel.symbols.GetFileInformationByHandleEx!(
      handle,
      FILE_ATTRIBUTE_TAG_INFO_CLASS,
      ffi.ptr(tag),
      tag.byteLength
    )) === 0) {
      const error = lastWindowsError(libraries, `Could not inspect ${target}`);
      closeWindowsHandle(libraries, handle, target);
      throw error;
    }
    const attributes = tag.readUInt32LE();
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      closeWindowsHandle(libraries, handle, target);
      throw new Error(`Windows private state path is a reparse point: ${target}`);
    }
    const isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0;
    if (isDirectory !== (kind === "directory")) {
      closeWindowsHandle(libraries, handle, target);
      throw new Error(
        `Windows private state path is not a ${kind}: ${target}`
      );
    }
    return handle;
  } finally {
    encoded.fill(0);
  }
}

export function openWindowsDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  access: number
): NativeHandle {
  return openWindowsPrivateStateObject(
    ffi,
    libraries,
    directory,
    access,
    "directory",
    FILE_SHARE_ALL
  );
}

export function requireStableWindowsPath(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string,
  expected: Buffer,
  kind: WindowsPrivateObjectKind
): void {
  const linked = openWindowsPrivateStateObject(
    ffi,
    libraries,
    target,
    FILE_READ_ATTRIBUTES,
    kind,
    FILE_SHARE_ALL
  );
  try {
    const actual = windowsFileIdentity(ffi, libraries, linked, target);
    if (!actual.equals(expected)) {
      throw new Error(`Windows private state path changed: ${target}`);
    }
  } finally {
    closeWindowsHandle(libraries, linked, target);
  }
}

export function snapshotWindowsDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string
): WindowsDirectorySnapshot {
  const handle = openWindowsDirectory(
    ffi,
    libraries,
    directory,
    FILE_READ_ATTRIBUTES
  );
  try {
    return {
      directory,
      identity: windowsFileIdentity(ffi, libraries, handle, directory)
    };
  } finally {
    closeWindowsHandle(libraries, handle, directory);
  }
}

export function requireStableWindowsSnapshot(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  snapshot: WindowsDirectorySnapshot
): void {
  const handle = openWindowsDirectory(
    ffi,
    libraries,
    snapshot.directory,
    FILE_READ_ATTRIBUTES
  );
  try {
    const actual = windowsFileIdentity(
      ffi,
      libraries,
      handle,
      snapshot.directory
    );
    if (!actual.equals(snapshot.identity)) {
      throw new Error(
        `Windows private state ancestor changed: ${snapshot.directory}`
      );
    }
  } finally {
    closeWindowsHandle(libraries, handle, snapshot.directory);
  }
}

export function windowsFileIdentity(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  handle: NativeHandle,
  target: string
): Buffer {
  const info = Buffer.alloc(52);
  if (Number(libraries.kernel.symbols.GetFileInformationByHandle!(
    handle,
    ffi.ptr(info)
  )) === 0) {
    throw lastWindowsError(libraries, `Could not identify ${target}`);
  }
  return Buffer.concat([
    info.subarray(28, 32),
    info.subarray(44, 52)
  ]);
}

export function wideWindowsString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}
