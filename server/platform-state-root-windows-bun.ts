import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  loadBunFfi,
  type BunFfi,
  type FfiLibrary
} from "./bun-ffi.js";
import type {
  WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";
import {
  privateAcl,
  validateHandleSecurity,
  type WindowsSecurityLibraries,
  type WindowsSecuritySids
} from "./platform-state-root-windows-bun-security.js";

const CSIDL_LOCAL_APP_DATA = 0x001c;
const SHGFP_TYPE_CURRENT = 0;
const ERROR_ALREADY_EXISTS = 183;
const FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
const FILE_READ_ATTRIBUTES = 0x0000_0080;
const READ_CONTROL = 0x0002_0000;
const WRITE_DAC = 0x0004_0000;
const FILE_SHARE_ALL = 0x0000_0007;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const WIN_LOCAL_SYSTEM_SID = 22;
const SECURITY_MAX_SID_SIZE = 68;
const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const PRIVATE_DACL_SECURITY_INFORMATION =
  PROTECTED_DACL_SECURITY_INFORMATION + DACL_SECURITY_INFORMATION;
const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
const INVALID_HANDLE_VALUE = -1n;

type NativeHandle = number | bigint;

interface WindowsLibraries extends WindowsSecurityLibraries {
  readonly kernel: FfiLibrary;
  readonly advapi: FfiLibrary;
  close(): void;
}

interface UserSids extends WindowsSecuritySids {
  readonly tokenHandle: NativeHandle;
  readonly tokenStorage: Buffer;
  readonly user: number;
  readonly systemStorage: Buffer;
  readonly system: number;
}

export function createBunWindowsPrivateStateRootAdapter(): WindowsPrivateStateRootAdapter {
  return {
    localAppDataDirectory: async () => await localAppDataDirectory(),
    preparePrivateStateRoot: async (root, trustedBase) => {
      const candidates = await privateDirectoryCandidates(root, trustedBase);
      const ffi = await loadBunFfi();
      const libraries = openLibraries(ffi);
      let sids: UserSids | undefined;
      try {
        sids = currentUserAndSystemSids(ffi, libraries);
        for (const candidate of candidates) {
          createDirectory(ffi, libraries, candidate);
          protectDirectory(ffi, libraries, candidate, sids);
        }
        for (const candidate of candidates) {
          validateDirectory(ffi, libraries, candidate, sids);
        }
      } finally {
        if (sids !== undefined) {
          closeHandle(libraries, sids.tokenHandle, "process token");
          sids.tokenStorage.fill(0);
          sids.systemStorage.fill(0);
        }
        libraries.close();
      }
      return root;
    }
  };
}

async function localAppDataDirectory(): Promise<string> {
  const ffi = await loadBunFfi();
  const shell = ffi.dlopen("shell32.dll", {
    SHGetFolderPathW: {
      args: ["ptr", "i32", "ptr", "u32", "ptr"],
      returns: "i32"
    }
  });
  const storage = Buffer.alloc(32_768 * 2);
  try {
    const result = Number(shell.symbols.SHGetFolderPathW!(
      0,
      CSIDL_LOCAL_APP_DATA,
      0,
      SHGFP_TYPE_CURRENT,
      ffi.ptr(storage)
    ));
    if (result !== 0) {
      throw new Error(`Windows LocalAppData lookup failed (${result})`);
    }
    const observed = decodeWideString(storage);
    if (observed === "") throw new Error("Windows returned an empty LocalAppData path");
    return await realpath(observed);
  } finally {
    storage.fill(0);
    shell.close();
  }
}

async function privateDirectoryCandidates(
  root: string,
  trustedBase: string | undefined
): Promise<readonly string[]> {
  if (trustedBase === undefined) {
    await mkdir(root, { recursive: true });
    return [root];
  }
  const relative = path.win32.relative(trustedBase, root);
  if (relative === ""
    || path.win32.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.win32.sep}`)) {
    throw new Error("Windows private state root is outside its trusted base");
  }
  const components = relative.split(path.win32.sep);
  if (components.some((component) =>
    component === "" || component === "." || component === "..")) {
    throw new Error("Windows private state root has an invalid component");
  }
  let cursor = trustedBase;
  return components.map((component) => {
    cursor = path.win32.join(cursor, component);
    return cursor;
  });
}

function openLibraries(ffi: BunFfi): WindowsLibraries {
  const kernel = ffi.dlopen("kernel32.dll", {
    CloseHandle: { args: ["i64"], returns: "i32" },
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
    CreateFileW: {
      args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "i64"],
      returns: "i64"
    },
    GetCurrentProcess: { args: [], returns: "i64" },
    GetFileInformationByHandle: { args: ["i64", "ptr"], returns: "i32" },
    GetFileInformationByHandleEx: {
      args: ["i64", "u32", "ptr", "u32"],
      returns: "i32"
    },
    GetLastError: { args: [], returns: "u32" },
    LocalFree: { args: ["ptr"], returns: "ptr" }
  });
  const advapi = ffi.dlopen("advapi32.dll", {
    AddAccessAllowedAceEx: {
      args: ["ptr", "u32", "u32", "u32", "ptr"],
      returns: "i32"
    },
    CreateWellKnownSid: {
      args: ["u32", "ptr", "ptr", "ptr"],
      returns: "i32"
    },
    EqualSid: { args: ["ptr", "ptr"], returns: "i32" },
    GetAce: { args: ["ptr", "u32", "ptr"], returns: "i32" },
    GetAclInformation: {
      args: ["ptr", "ptr", "u32", "u32"],
      returns: "i32"
    },
    GetLengthSid: { args: ["ptr"], returns: "u32" },
    GetSecurityDescriptorControl: {
      args: ["ptr", "ptr", "ptr"],
      returns: "i32"
    },
    GetSecurityInfo: {
      args: ["i64", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"],
      returns: "u32"
    },
    GetTokenInformation: {
      args: ["i64", "u32", "ptr", "u32", "ptr"],
      returns: "i32"
    },
    InitializeAcl: { args: ["ptr", "u32", "u32"], returns: "i32" },
    OpenProcessToken: { args: ["i64", "u32", "ptr"], returns: "i32" },
    SetSecurityInfo: {
      args: ["i64", "u32", "u32", "ptr", "ptr", "ptr", "ptr"],
      returns: "u32"
    }
  });
  return {
    kernel,
    advapi,
    close: () => {
      advapi.close();
      kernel.close();
    }
  };
}

function currentUserAndSystemSids(
  ffi: BunFfi,
  libraries: WindowsLibraries
): UserSids {
  const tokenOut = Buffer.alloc(8);
  if (Number(libraries.advapi.symbols.OpenProcessToken!(
    libraries.kernel.symbols.GetCurrentProcess!(),
    TOKEN_QUERY,
    ffi.ptr(tokenOut)
  )) === 0) {
    throw lastWindowsError(libraries, "Could not open the process token");
  }
  const tokenHandle = tokenOut.readBigUInt64LE();
  const required = Buffer.alloc(4);
  libraries.advapi.symbols.GetTokenInformation!(
    tokenHandle,
    TOKEN_USER,
    0,
    0,
    ffi.ptr(required)
  );
  const tokenBytes = required.readUInt32LE();
  if (tokenBytes < 8 || tokenBytes > 64 * 1024) {
    closeHandle(libraries, tokenHandle, "process token");
    throw new Error("Windows returned an invalid token user size");
  }
  const tokenStorage = Buffer.alloc(tokenBytes);
  if (Number(libraries.advapi.symbols.GetTokenInformation!(
    tokenHandle,
    TOKEN_USER,
    ffi.ptr(tokenStorage),
    tokenStorage.byteLength,
    ffi.ptr(required)
  )) === 0) {
    closeHandle(libraries, tokenHandle, "process token");
    throw lastWindowsError(libraries, "Could not read the process user SID");
  }
  const user = safePointer(tokenStorage.readBigUInt64LE(), "process user SID");
  const systemStorage = Buffer.alloc(SECURITY_MAX_SID_SIZE);
  const systemSize = Buffer.alloc(4);
  systemSize.writeUInt32LE(systemStorage.byteLength);
  if (Number(libraries.advapi.symbols.CreateWellKnownSid!(
    WIN_LOCAL_SYSTEM_SID,
    0,
    ffi.ptr(systemStorage),
    ffi.ptr(systemSize)
  )) === 0) {
    closeHandle(libraries, tokenHandle, "process token");
    throw lastWindowsError(libraries, "Could not create the SYSTEM SID");
  }
  return {
    tokenHandle,
    tokenStorage,
    user,
    systemStorage,
    system: ffi.ptr(systemStorage)
  };
}

function createDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string
): void {
  const encoded = wideString(directory);
  try {
    const created = Number(libraries.kernel.symbols.CreateDirectoryW!(
      ffi.ptr(encoded),
      0
    ));
    if (created === 0
      && Number(libraries.kernel.symbols.GetLastError!()) !== ERROR_ALREADY_EXISTS) {
      throw lastWindowsError(libraries, `Could not create ${directory}`);
    }
  } finally {
    encoded.fill(0);
  }
}

function protectDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  sids: UserSids
): void {
  const handle = openPrivateDirectory(ffi, libraries, directory);
  try {
    const before = fileIdentity(ffi, libraries, handle, directory);
    const acl = privateAcl(ffi, libraries, sids);
    try {
      const result = Number(libraries.advapi.symbols.SetSecurityInfo!(
        handle,
        SE_FILE_OBJECT,
        PRIVATE_DACL_SECURITY_INFORMATION,
        0,
        0,
        ffi.ptr(acl),
        0
      ));
      if (result !== 0) {
        throw new Error(`Could not protect ${directory} (Windows error ${result})`);
      }
      validateHandleSecurity(ffi, libraries, handle, directory, sids);
      requireStablePath(ffi, libraries, directory, before);
    } finally {
      acl.fill(0);
    }
  } finally {
    closeHandle(libraries, handle, directory);
  }
}

function validateDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  sids: UserSids
): void {
  const handle = openPrivateDirectory(ffi, libraries, directory);
  try {
    validateHandleSecurity(ffi, libraries, handle, directory, sids);
    requireStablePath(
      ffi,
      libraries,
      directory,
      fileIdentity(ffi, libraries, handle, directory)
    );
  } finally {
    closeHandle(libraries, handle, directory);
  }
}

function openPrivateDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string
): NativeHandle {
  const encoded = wideString(directory);
  try {
    const handle = libraries.kernel.symbols.CreateFileW!(
      ffi.ptr(encoded),
      FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC,
      FILE_SHARE_ALL,
      0,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      0
    );
    if (BigInt(handle) === INVALID_HANDLE_VALUE) {
      throw lastWindowsError(libraries, `Could not open ${directory}`);
    }
    const tag = Buffer.alloc(8);
    if (Number(libraries.kernel.symbols.GetFileInformationByHandleEx!(
      handle,
      FILE_ATTRIBUTE_TAG_INFO_CLASS,
      ffi.ptr(tag),
      tag.byteLength
    )) === 0) {
      closeHandle(libraries, handle, directory);
      throw lastWindowsError(libraries, `Could not inspect ${directory}`);
    }
    const attributes = tag.readUInt32LE();
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      closeHandle(libraries, handle, directory);
      throw new Error(`Windows private state path is a reparse point: ${directory}`);
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) {
      closeHandle(libraries, handle, directory);
      throw new Error(`Windows private state path is not a directory: ${directory}`);
    }
    return handle;
  } finally {
    encoded.fill(0);
  }
}

function requireStablePath(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  expected: Buffer
): void {
  const linked = openPrivateDirectory(ffi, libraries, directory);
  try {
    const actual = fileIdentity(ffi, libraries, linked, directory);
    if (!actual.equals(expected)) {
      throw new Error(`Windows private state path changed: ${directory}`);
    }
  } finally {
    closeHandle(libraries, linked, directory);
  }
}

function fileIdentity(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  handle: NativeHandle,
  directory: string
): Buffer {
  const info = Buffer.alloc(52);
  if (Number(libraries.kernel.symbols.GetFileInformationByHandle!(
    handle,
    ffi.ptr(info)
  )) === 0) {
    throw lastWindowsError(libraries, `Could not identify ${directory}`);
  }
  return Buffer.concat([
    info.subarray(28, 32),
    info.subarray(44, 52)
  ]);
}

function closeHandle(
  libraries: WindowsLibraries,
  handle: NativeHandle,
  label: string
): void {
  if (Number(libraries.kernel.symbols.CloseHandle!(handle)) === 0) {
    throw lastWindowsError(libraries, `Could not close ${label}`);
  }
}

function lastWindowsError(
  libraries: WindowsLibraries,
  message: string
): Error {
  return new Error(
    `${message} (Windows error ${Number(libraries.kernel.symbols.GetLastError!())})`
  );
}

function safePointer(value: bigint, label: string): number {
  const pointer = Number(value);
  if (value === 0n || !Number.isSafeInteger(pointer)) {
    throw new Error(`Windows returned an invalid ${label} pointer`);
  }
  return pointer;
}

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function decodeWideString(value: Buffer): string {
  let end = 0;
  while (end + 1 < value.byteLength
    && (value[end] !== 0 || value[end + 1] !== 0)) {
    end += 2;
  }
  return value.subarray(0, end).toString("utf16le");
}
