import type {
  BunFfi,
  FfiLibrary
} from "./bun-ffi.js";
import type {
  WindowsSecurityLibraries,
  WindowsSecuritySids
} from "./platform-state-root-windows-bun-security.js";

const TOKEN_ADJUST_PRIVILEGES = 0x0020;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const WIN_LOCAL_SYSTEM_SID = 22;
const SECURITY_MAX_SID_SIZE = 68;
const SE_PRIVILEGE_ENABLED = 0x0000_0002;
const ERROR_NOT_ALL_ASSIGNED = 1300;
const TAKE_OWNERSHIP_PRIVILEGE = "SeTakeOwnershipPrivilege";

export type NativeHandle = number | bigint;

export interface WindowsLibraries extends WindowsSecurityLibraries {
  readonly kernel: FfiLibrary;
  readonly advapi: FfiLibrary;
  close(): void;
}

export interface UserSids extends WindowsSecuritySids {
  readonly tokenHandle: NativeHandle;
  readonly tokenStorage: Buffer;
  readonly user: number;
  readonly systemStorage: Buffer;
  readonly system: number;
}

export class WindowsCallError extends Error {
  constructor(message: string, readonly windowsCode: number) {
    super(`${message} (Windows error ${windowsCode})`);
    this.name = "WindowsCallError";
  }
}

export function openWindowsLibraries(ffi: BunFfi): WindowsLibraries {
  const kernel = ffi.dlopen("kernel32.dll", {
    CloseHandle: { args: ["i64"], returns: "i32" },
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
    CreateFileW: {
      args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "i64"],
      returns: "i64"
    },
    GetCurrentProcess: { args: [], returns: "i64" },
    GetFileInformationByHandle: {
      args: ["i64", "ptr"],
      returns: "i32"
    },
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
    AdjustTokenPrivileges: {
      args: ["i64", "i32", "ptr", "u32", "ptr", "ptr"],
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
    LookupPrivilegeValueW: {
      args: ["ptr", "ptr", "ptr"],
      returns: "i32"
    },
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

export function currentUserAndSystemSids(
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
    closeWindowsHandle(libraries, tokenHandle, "process token");
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
    closeWindowsHandle(libraries, tokenHandle, "process token");
    throw lastWindowsError(libraries, "Could not read the process user SID");
  }
  const user = safePointer(
    tokenStorage.readBigUInt64LE(),
    "process user SID"
  );
  const systemStorage = Buffer.alloc(SECURITY_MAX_SID_SIZE);
  const systemSize = Buffer.alloc(4);
  systemSize.writeUInt32LE(systemStorage.byteLength);
  if (Number(libraries.advapi.symbols.CreateWellKnownSid!(
    WIN_LOCAL_SYSTEM_SID,
    0,
    ffi.ptr(systemStorage),
    ffi.ptr(systemSize)
  )) === 0) {
    closeWindowsHandle(libraries, tokenHandle, "process token");
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

export function disposeUserSids(
  libraries: WindowsLibraries,
  sids: UserSids
): void {
  closeWindowsHandle(libraries, sids.tokenHandle, "process token");
  sids.tokenStorage.fill(0);
  sids.systemStorage.fill(0);
}

export function withTakeOwnershipPrivilege<T>(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  operation: () => T
): T {
  const tokenOut = Buffer.alloc(8);
  const privilegeName = wideString(TAKE_OWNERSHIP_PRIVILEGE);
  const luid = Buffer.alloc(8);
  const requested = Buffer.alloc(16);
  const previous = Buffer.alloc(64);
  const previousBytes = Buffer.alloc(4);
  try {
    if (Number(libraries.advapi.symbols.OpenProcessToken!(
      libraries.kernel.symbols.GetCurrentProcess!(),
      TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES,
      ffi.ptr(tokenOut)
    )) === 0) {
      throw lastWindowsError(
        libraries,
        "Could not open the process token for ownership repair"
      );
    }
    const tokenHandle = tokenOut.readBigUInt64LE();
    try {
      return withTokenTakeOwnershipPrivilege(
        ffi,
        libraries,
        tokenHandle,
        privilegeName,
        luid,
        requested,
        previous,
        previousBytes,
        operation
      );
    } finally {
      closeWindowsHandle(
        libraries,
        tokenHandle,
        "ownership-repair process token"
      );
    }
  } finally {
    tokenOut.fill(0);
    privilegeName.fill(0);
    luid.fill(0);
    requested.fill(0);
    previous.fill(0);
    previousBytes.fill(0);
  }
}

function withTokenTakeOwnershipPrivilege<T>(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  tokenHandle: NativeHandle,
  privilegeName: Buffer,
  luid: Buffer,
  requested: Buffer,
  previous: Buffer,
  previousBytes: Buffer,
  operation: () => T
): T {
  if (Number(libraries.advapi.symbols.LookupPrivilegeValueW!(
    0,
    ffi.ptr(privilegeName),
    ffi.ptr(luid)
  )) === 0) {
    throw lastWindowsError(
      libraries,
      "Could not resolve the take-ownership privilege"
    );
  }
  requested.writeUInt32LE(1, 0);
  luid.copy(requested, 4);
  requested.writeUInt32LE(SE_PRIVILEGE_ENABLED, 12);
  if (Number(libraries.advapi.symbols.AdjustTokenPrivileges!(
    tokenHandle,
    0,
    ffi.ptr(requested),
    previous.byteLength,
    ffi.ptr(previous),
    ffi.ptr(previousBytes)
  )) === 0) {
    throw lastWindowsError(
      libraries,
      "Could not enable the take-ownership privilege"
    );
  }
  const status = Number(libraries.kernel.symbols.GetLastError!());
  if (status === ERROR_NOT_ALL_ASSIGNED) {
    throw new WindowsCallError(
      "The process token has no take-ownership privilege",
      status
    );
  }
  if (status !== 0) {
    throw new WindowsCallError(
      "Could not enable the take-ownership privilege",
      status
    );
  }
  const length = previousBytes.readUInt32LE();
  if (length < 4 || length > previous.byteLength) {
    throw new Error("Windows returned invalid previous token privileges");
  }
  try {
    return operation();
  } finally {
    if (Number(libraries.advapi.symbols.AdjustTokenPrivileges!(
      tokenHandle,
      0,
      ffi.ptr(previous),
      0,
      0,
      0
    )) === 0) {
      throw lastWindowsError(
        libraries,
        "Could not restore process token privileges"
      );
    }
  }
}

export function closeWindowsHandle(
  libraries: WindowsLibraries,
  handle: NativeHandle,
  label: string
): void {
  if (Number(libraries.kernel.symbols.CloseHandle!(handle)) === 0) {
    throw lastWindowsError(libraries, `Could not close ${label}`);
  }
}

export function lastWindowsError(
  libraries: WindowsLibraries,
  message: string
): WindowsCallError {
  return new WindowsCallError(
    message,
    Number(libraries.kernel.symbols.GetLastError!())
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
