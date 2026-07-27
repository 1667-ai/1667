import {
  loadBunFfi,
  type BunFfi
} from "./bun-ffi.js";
import type {
  WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";
import {
  handleHasOwner,
  privateAcl,
  validateHandleSecurity
} from "./platform-state-root-windows-bun-security.js";
import {
  prepareWindowsPrivateDirectoryPlan,
  requireCanonicalWindowsDirectory
} from "./platform-state-root-windows-path.js";
import {
  windowsLocalAppDataDirectory
} from "./platform-state-root-windows-local-app-data.js";
import {
  closeWindowsHandle,
  currentUserAndSystemSids,
  disposeUserSids,
  lastWindowsError,
  openWindowsLibraries,
  WindowsCallError,
  withTakeOwnershipPrivilege,
  type NativeHandle,
  type UserSids,
  type WindowsLibraries
} from "./platform-state-root-windows-bun-api.js";

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
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x0000_0001;
const DACL_SECURITY_INFORMATION = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const PRIVATE_DACL_SECURITY_INFORMATION =
  PROTECTED_DACL_SECURITY_INFORMATION + DACL_SECURITY_INFORMATION;
const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
const INVALID_HANDLE_VALUE = -1n;

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
      const libraries = openWindowsLibraries(ffi);
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
          disposeUserSids(libraries, sids);
        }
        libraries.close();
      }
      return root;
    }
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
  const handle = openOwnedDirectoryForRepair(
    ffi,
    libraries,
    directory,
    sids
  );
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
    closeWindowsHandle(libraries, handle, directory);
  }
}

function openOwnedDirectoryForRepair(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  sids: UserSids
): NativeHandle {
  let handle: NativeHandle;
  try {
    handle = openOwnedDirectory(ffi, libraries, directory);
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    takeDirectoryOwnership(ffi, libraries, directory, sids);
    return requireOwnedDirectory(ffi, libraries, directory, sids);
  }
  try {
    if (handleHasOwner(ffi, libraries, handle, sids.user)) {
      return handle;
    }
  } catch (error) {
    closeWindowsHandle(libraries, handle, directory);
    throw error;
  }
  closeWindowsHandle(libraries, handle, directory);
  takeDirectoryOwnership(ffi, libraries, directory, sids);
  return requireOwnedDirectory(ffi, libraries, directory, sids);
}

function takeDirectoryOwnership(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  sids: UserSids
): void {
  const takeOwnership = (): void => {
    const handle = openDirectory(
      ffi,
      libraries,
      directory,
      FILE_READ_ATTRIBUTES | WRITE_OWNER
    );
    try {
      const result = Number(libraries.advapi.symbols.SetSecurityInfo!(
        handle,
        SE_FILE_OBJECT,
        OWNER_SECURITY_INFORMATION,
        sids.user,
        0,
        0,
        0
      ));
      if (result !== 0) {
        throw new WindowsCallError(
          `Could not repair ${directory} owner`,
          result
        );
      }
    } finally {
      closeWindowsHandle(libraries, handle, directory);
    }
  };
  try {
    takeOwnership();
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    withTakeOwnershipPrivilege(
      ffi,
      libraries,
      takeOwnership
    );
  }
}

function requireOwnedDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  sids: UserSids
): NativeHandle {
  const handle = openOwnedDirectory(ffi, libraries, directory);
  try {
    if (!handleHasOwner(ffi, libraries, handle, sids.user)) {
      throw new Error(
        `Windows private state owner is unsafe: ${directory}`
      );
    }
    return handle;
  } catch (error) {
    closeWindowsHandle(libraries, handle, directory);
    throw error;
  }
}

function isAccessDenied(error: unknown): boolean {
  return error instanceof WindowsCallError && error.windowsCode === 5;
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
    closeWindowsHandle(libraries, handle, directory);
  }
}

function openOwnedDirectory(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string
): NativeHandle {
  return openDirectory(
    ffi,
    libraries,
    directory,
    FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC
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
      closeWindowsHandle(libraries, handle, directory);
      throw lastWindowsError(libraries, `Could not inspect ${directory}`);
    }
    const attributes = tag.readUInt32LE();
    if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      closeWindowsHandle(libraries, handle, directory);
      throw new Error(`Windows private state path is a reparse point: ${directory}`);
    }
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) {
      closeWindowsHandle(libraries, handle, directory);
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
    closeWindowsHandle(libraries, linked, directory);
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
    closeWindowsHandle(libraries, handle, directory);
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
    closeWindowsHandle(libraries, handle, snapshot.directory);
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

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}
