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
import {
  prepareWindowsPrivateDirectoryPlan,
  requireCanonicalWindowsDirectory
} from "./platform-state-root-windows-path.js";
import {
  windowsLocalAppDataDirectory
} from "./platform-state-root-windows-local-app-data.js";

const ERROR_ALREADY_EXISTS = 183;
const FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
const FILE_READ_ATTRIBUTES = 0x0000_0080;
const READ_CONTROL = 0x0002_0000;
const WRITE_DAC = 0x0004_0000;
const WRITE_OWNER = 0x0008_0000;
const FILE_SHARE_ALL = 0x0000_0007;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const WIN_LOCAL_SYSTEM_SID = 22;
const SECURITY_MAX_SID_SIZE = 68;
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x0000_0001;
const DACL_SECURITY_INFORMATION = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const PRIVATE_DACL_SECURITY_INFORMATION =
  OWNER_SECURITY_INFORMATION
  + PROTECTED_DACL_SECURITY_INFORMATION
  + DACL_SECURITY_INFORMATION;
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

interface DirectorySnapshot {
  readonly directory: string;
  readonly identity: Buffer;
}

export function createBunWindowsPrivateStateRootAdapter(): WindowsPrivateStateRootAdapter {
  return {
    localAppDataDirectory: async () => await windowsLocalAppDataDirectory(),
    preparePrivateStateRoot: async (root, trustedBase) => {
      const plan = await prepareWindowsPrivateDirectoryPlan(root, trustedBase);
      const ffi = await loadBunFfi();
      const libraries = openLibraries(ffi);
      let sids: UserSids | undefined;
      try {
        sids = currentUserAndSystemSids(ffi, libraries);
        const ancestors = plan.stableAncestors.map((directory) =>
          snapshotDirectory(ffi, libraries, directory));
        for (const candidate of plan.candidates) {
          createDirectory(ffi, libraries, candidate);
          protectDirectory(ffi, libraries, candidate, sids);
        }
        await requireCanonicalWindowsDirectory(root);
        for (const candidate of plan.candidates) {
          validateDirectory(ffi, libraries, candidate, sids);
        }
        for (const ancestor of ancestors) {
          requireStableSnapshot(ffi, libraries, ancestor);
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
        sids.user,
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
  const handle = openDirectory(
    ffi,
    libraries,
    directory,
    FILE_READ_ATTRIBUTES | READ_CONTROL
  );
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
  return openDirectory(
    ffi,
    libraries,
    directory,
    FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC | WRITE_OWNER
  );
}

function openDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  access: number
): NativeHandle {
  const encoded = wideString(directory);
  try {
    const handle = libraries.kernel.symbols.CreateFileW!(
      ffi.ptr(encoded),
      access,
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
  const linked = openDirectory(
    ffi,
    libraries,
    directory,
    FILE_READ_ATTRIBUTES
  );
  try {
    const actual = fileIdentity(ffi, libraries, linked, directory);
    if (!actual.equals(expected)) {
      throw new Error(`Windows private state path changed: ${directory}`);
    }
  } finally {
    closeHandle(libraries, linked, directory);
  }
}

function snapshotDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string
): DirectorySnapshot {
  const handle = openDirectory(
    ffi,
    libraries,
    directory,
    FILE_READ_ATTRIBUTES
  );
  try {
    return {
      directory,
      identity: fileIdentity(ffi, libraries, handle, directory)
    };
  } finally {
    closeHandle(libraries, handle, directory);
  }
}

function requireStableSnapshot(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  snapshot: DirectorySnapshot
): void {
  const handle = openDirectory(
    ffi,
    libraries,
    snapshot.directory,
    FILE_READ_ATTRIBUTES
  );
  try {
    const actual = fileIdentity(
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
    closeHandle(libraries, handle, snapshot.directory);
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
