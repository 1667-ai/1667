import type {
  BunFfi,
  FfiLibrary
} from "./bun-ffi.js";
import {
  WindowsCallError
} from "./platform-state-root-windows-bun-api.js";

const ACL_REVISION = 2;
const ACCESS_ALLOWED_ACE_TYPE = 0;
const OBJECT_INHERIT_ACE = 0x01;
const CONTAINER_INHERIT_ACE = 0x02;
const INHERITANCE_FLAGS = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
const FILE_ALL_ACCESS = 0x001f_01ff;
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x0000_0001;
const DACL_SECURITY_INFORMATION = 0x0000_0004;
const SE_DACL_PROTECTED = 0x1000;
const ACL_SIZE_INFORMATION_CLASS = 2;

export type WindowsPrivateObjectKind = "directory" | "file";

export interface WindowsSecurityLibraries {
  readonly kernel: FfiLibrary;
  readonly advapi: FfiLibrary;
}

export interface WindowsSecuritySids {
  readonly user: number;
  readonly system: number;
}

export function privateAcl(
  ffi: BunFfi,
  libraries: WindowsSecurityLibraries,
  sids: WindowsSecuritySids,
  kind: WindowsPrivateObjectKind
): Buffer {
  const principals = privatePrincipals(libraries, sids);
  const size = principals.reduce(
    (total, sid) => total + alignDword(
      8 + Number(libraries.advapi.symbols.GetLengthSid!(sid))
    ),
    8
  );
  const acl = Buffer.alloc(size);
  if (Number(libraries.advapi.symbols.InitializeAcl!(
    ffi.ptr(acl),
    acl.byteLength,
    ACL_REVISION
  )) === 0) {
    throw lastWindowsError(libraries, "Could not initialize a private DACL");
  }
  for (const sid of principals) {
    if (Number(libraries.advapi.symbols.AddAccessAllowedAceEx!(
      ffi.ptr(acl),
      ACL_REVISION,
      expectedInheritanceFlags(kind),
      FILE_ALL_ACCESS,
      sid
    )) === 0) {
      throw lastWindowsError(libraries, "Could not add a private DACL entry");
    }
  }
  return acl;
}

export function validateHandleSecurity(
  ffi: BunFfi,
  libraries: WindowsSecurityLibraries,
  handle: number | bigint,
  directory: string,
  sids: WindowsSecuritySids,
  kind: WindowsPrivateObjectKind
): void {
  const ownerOut = Buffer.alloc(8);
  const daclOut = Buffer.alloc(8);
  const descriptorOut = Buffer.alloc(8);
  const result = Number(libraries.advapi.symbols.GetSecurityInfo!(
    handle,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    ffi.ptr(ownerOut),
    0,
    ffi.ptr(daclOut),
    0,
    ffi.ptr(descriptorOut)
  ));
  if (result !== 0) {
    throw new Error(
      `Could not inspect ${directory} DACL (Windows error ${result})`
    );
  }
  const descriptor = safePointer(
    descriptorOut.readBigUInt64LE(),
    "security descriptor"
  );
  try {
    const owner = safePointer(
      ownerOut.readBigUInt64LE(),
      "directory owner SID"
    );
    const daclValue = daclOut.readBigUInt64LE();
    if (daclValue === 0n) {
      throw new WindowsPrivateSecurityMismatch(
        `Windows private state DACL is null: ${directory}`
      );
    }
    const dacl = safePointer(daclValue, "directory DACL");
    if (Number(libraries.advapi.symbols.EqualSid!(owner, sids.user)) === 0) {
      throw new WindowsPrivateSecurityMismatch(
        `Windows private state owner is unsafe: ${directory}`
      );
    }
    requireProtectedDescriptor(ffi, libraries, descriptor, directory);
    requireExactPrivateAcl(ffi, libraries, dacl, directory, sids, kind);
  } finally {
    libraries.kernel.symbols.LocalFree!(descriptor);
  }
}

export function handleHasExactPrivateSecurity(
  ffi: BunFfi,
  libraries: WindowsSecurityLibraries,
  handle: number | bigint,
  target: string,
  sids: WindowsSecuritySids,
  kind: WindowsPrivateObjectKind
): boolean {
  try {
    validateHandleSecurity(ffi, libraries, handle, target, sids, kind);
    return true;
  } catch (error) {
    if (error instanceof WindowsPrivateSecurityMismatch) return false;
    throw error;
  }
}

export function handleHasOwner(
  ffi: BunFfi,
  libraries: WindowsSecurityLibraries,
  handle: number | bigint,
  expected: number
): boolean {
  const ownerOut = Buffer.alloc(8);
  const descriptorOut = Buffer.alloc(8);
  const result = Number(libraries.advapi.symbols.GetSecurityInfo!(
    handle,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION,
    ffi.ptr(ownerOut),
    0,
    0,
    0,
    ffi.ptr(descriptorOut)
  ));
  if (result !== 0) {
    throw new WindowsCallError("Could not inspect directory owner", result);
  }
  const descriptor = safePointer(
    descriptorOut.readBigUInt64LE(),
    "security descriptor"
  );
  try {
    const owner = safePointer(
      ownerOut.readBigUInt64LE(),
      "directory owner SID"
    );
    return Number(libraries.advapi.symbols.EqualSid!(
      owner,
      expected
    )) !== 0;
  } finally {
    libraries.kernel.symbols.LocalFree!(descriptor);
  }
}

function requireProtectedDescriptor(
  ffi: BunFfi,
  libraries: WindowsSecurityLibraries,
  descriptor: number,
  directory: string
): void {
  const control = Buffer.alloc(2);
  const revision = Buffer.alloc(4);
  if (Number(libraries.advapi.symbols.GetSecurityDescriptorControl!(
    descriptor,
    ffi.ptr(control),
    ffi.ptr(revision)
  )) === 0) {
    throw lastWindowsError(
      libraries,
      `Could not read ${directory} security descriptor`
    );
  }
  if ((control.readUInt16LE() & SE_DACL_PROTECTED) === 0) {
    throw new WindowsPrivateSecurityMismatch(
      `Windows private state DACL is not protected: ${directory}`
    );
  }
}

function requireExactPrivateAcl(
  ffi: BunFfi,
  libraries: WindowsSecurityLibraries,
  dacl: number,
  directory: string,
  sids: WindowsSecuritySids,
  kind: WindowsPrivateObjectKind
): void {
  const principals = privatePrincipals(libraries, sids);
  const info = Buffer.alloc(12);
  if (Number(libraries.advapi.symbols.GetAclInformation!(
    dacl,
    ffi.ptr(info),
    info.byteLength,
    ACL_SIZE_INFORMATION_CLASS
  )) === 0) {
    throw lastWindowsError(libraries, `Could not read ${directory} DACL`);
  }
  if (info.readUInt32LE() !== principals.length) {
    throw new WindowsPrivateSecurityMismatch(
      `Windows private state DACL has unexpected entries: ${directory}`
    );
  }
  let userSeen = false;
  let systemSeen = false;
  for (let index = 0; index < principals.length; index += 1) {
    const aceOut = Buffer.alloc(8);
    if (Number(libraries.advapi.symbols.GetAce!(
      dacl,
      index,
      ffi.ptr(aceOut)
    )) === 0) {
      throw lastWindowsError(
        libraries,
        `Could not read ${directory} DACL`
      );
    }
    const ace = safePointer(aceOut.readBigUInt64LE(), "DACL entry");
    const header = Buffer.from(ffi.toArrayBuffer(ace, 0, 8));
    if (header.readUInt8(0) !== ACCESS_ALLOWED_ACE_TYPE
      || header.readUInt8(1) !== expectedInheritanceFlags(kind)
      || header.readUInt32LE(4) !== FILE_ALL_ACCESS) {
      throw new WindowsPrivateSecurityMismatch(
        `Windows private state DACL is unsafe: ${directory}`
      );
    }
    const sid = ace + 8;
    if (Number(libraries.advapi.symbols.EqualSid!(sid, sids.user)) !== 0) {
      if (userSeen) {
        throw new WindowsPrivateSecurityMismatch(
          `Windows private state DACL repeats its user: ${directory}`
        );
      }
      userSeen = true;
      if (principals.length === 1) systemSeen = true;
    } else if (
      Number(libraries.advapi.symbols.EqualSid!(sid, sids.system)) !== 0
    ) {
      if (systemSeen) {
        throw new WindowsPrivateSecurityMismatch(
          `Windows private state DACL repeats SYSTEM: ${directory}`
        );
      }
      systemSeen = true;
    } else {
      throw new WindowsPrivateSecurityMismatch(
        `Windows private state DACL grants another SID: ${directory}`
      );
    }
  }
  if (!userSeen || !systemSeen) {
    throw new WindowsPrivateSecurityMismatch(
      `Windows private state DACL is incomplete: ${directory}`
    );
  }
}

class WindowsPrivateSecurityMismatch extends Error {}

function privatePrincipals(
  libraries: WindowsSecurityLibraries,
  sids: WindowsSecuritySids
): readonly number[] {
  return Number(libraries.advapi.symbols.EqualSid!(
    sids.user,
    sids.system
  )) === 0
    ? [sids.user, sids.system]
    : [sids.user];
}

function expectedInheritanceFlags(kind: WindowsPrivateObjectKind): number {
  return kind === "directory" ? INHERITANCE_FLAGS : 0;
}

function lastWindowsError(
  libraries: WindowsSecurityLibraries,
  message: string
): Error {
  return new Error(
    `${message} (Windows error ${
      Number(libraries.kernel.symbols.GetLastError!())
    })`
  );
}

function safePointer(value: bigint, label: string): number {
  const pointer = Number(value);
  if (!Number.isSafeInteger(pointer) || pointer === 0) {
    throw new Error(`Windows returned an invalid ${label}`);
  }
  return pointer;
}

function alignDword(value: number): number {
  return (value + 3) & ~3;
}
