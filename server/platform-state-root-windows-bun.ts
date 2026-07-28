import {
  loadBunFfi,
  type BunFfi
} from "./bun-ffi.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
  WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";
import {
  handleHasExactPrivateSecurity,
  handleHasOwner,
  privateAcl,
  validateHandleSecurity,
  type WindowsPrivateObjectKind
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
import {
  FILE_READ_ATTRIBUTES,
  FILE_SHARE_ALL,
  FILE_SHARE_REPAIR,
  openWindowsDirectory,
  openWindowsPrivateStateObject,
  READ_CONTROL,
  requireSingleWindowsFileLink,
  requireStableWindowsPath,
  requireStableWindowsSnapshot,
  snapshotWindowsDirectory,
  wideWindowsString,
  windowsFileIdentity
} from "./platform-state-root-windows-bun-object.js";

const ERROR_ALREADY_EXISTS = 183;
const WRITE_OWNER = 0x0008_0000;
const MAXIMUM_ALLOWED = 0x0200_0000;
const SE_FILE_OBJECT = 1;
const OWNER_SECURITY_INFORMATION = 0x0000_0001;
const DACL_SECURITY_INFORMATION = 0x0000_0004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
const PRIVATE_DACL_SECURITY_INFORMATION =
  PROTECTED_DACL_SECURITY_INFORMATION + DACL_SECURITY_INFORMATION;

interface ProtectedStateObject {
  readonly handle: NativeHandle;
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
          snapshotWindowsDirectory(ffi, libraries, directory));
        for (const candidate of plan.candidates) {
          createDirectory(ffi, libraries, candidate);
        }
        for (const candidate of plan.candidates) {
          if (candidate === root) {
            await protectPrivateStateTree(ffi, libraries, candidate, sids);
          } else {
            protectDirectory(ffi, libraries, candidate, sids);
          }
        }
        await requireCanonicalWindowsDirectory(root);
        for (const candidate of plan.candidates) {
          validateDirectory(ffi, libraries, candidate, sids);
        }
        for (const ancestor of ancestors) {
          requireStableWindowsSnapshot(ffi, libraries, ancestor);
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
  const encoded = wideWindowsString(directory);
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
  const secured = protectPrivateStateObject(
    ffi,
    libraries,
    directory,
    sids,
    "directory"
  );
  try {
    requireStableWindowsPath(
      ffi,
      libraries,
      directory,
      secured.identity,
      "directory"
    );
  } finally {
    closeWindowsHandle(libraries, secured.handle, directory);
  }
}

async function protectPrivateStateTree(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  directory: string,
  sids: UserSids
): Promise<void> {
  const secured = protectPrivateStateObject(
    ffi,
    libraries,
    directory,
    sids,
    "directory"
  );
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Windows private state path is a reparse point: ${target}`
        );
      }
      if (entry.isDirectory()) {
        await protectPrivateStateTree(ffi, libraries, target, sids);
      } else if (entry.isFile()) {
        protectFile(ffi, libraries, target, sids);
      } else {
        throw new Error(
          `Windows private state path has an unsupported type: ${target}`
        );
      }
    }
    requireStableWindowsPath(
      ffi,
      libraries,
      directory,
      secured.identity,
      "directory"
    );
  } finally {
    closeWindowsHandle(libraries, secured.handle, directory);
  }
}

function protectFile(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  file: string,
  sids: UserSids
): void {
  const secured = protectPrivateStateObject(
    ffi,
    libraries,
    file,
    sids,
    "file"
  );
  try {
    requireStableWindowsPath(
      ffi,
      libraries,
      file,
      secured.identity,
      "file"
    );
  } finally {
    closeWindowsHandle(libraries, secured.handle, file);
  }
}

function protectPrivateStateObject(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string,
  sids: UserSids,
  kind: WindowsPrivateObjectKind
): ProtectedStateObject {
  const handle = openOwnedObjectForRepair(
    ffi,
    libraries,
    target,
    sids,
    kind
  );
  try {
    const identity = windowsFileIdentity(ffi, libraries, handle, target);
    if (handleHasExactPrivateSecurity(
      ffi,
      libraries,
      handle,
      target,
      sids,
      kind
    )) {
      return { handle, identity };
    }
    const acl = privateAcl(ffi, libraries, sids, kind);
    try {
      // MAXIMUM_ALLOWED prevents SetSecurityInfo from propagating this DACL.
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
        throw new Error(`Could not protect ${target} (Windows error ${result})`);
      }
      validateHandleSecurity(ffi, libraries, handle, target, sids, kind);
      return { handle, identity };
    } finally {
      acl.fill(0);
    }
  } catch (error) {
    closeWindowsHandle(libraries, handle, target);
    throw error;
  }
}

function openOwnedObjectForRepair(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string,
  sids: UserSids,
  kind: WindowsPrivateObjectKind
): NativeHandle {
  let handle: NativeHandle;
  try {
    handle = openOwnedObject(ffi, libraries, target, kind);
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    if (kind === "file") {
      requireSingleFileLinkBeforeRepair(ffi, libraries, target);
    }
    takeObjectOwnership(ffi, libraries, target, sids, kind);
    return requireOwnedObject(ffi, libraries, target, sids, kind);
  }
  if (kind === "file") {
    try {
      requireSingleWindowsFileLink(ffi, libraries, handle, target);
    } catch (error) {
      closeWindowsHandle(libraries, handle, target);
      throw error;
    }
  }
  try {
    if (handleHasOwner(ffi, libraries, handle, sids.user)) {
      return handle;
    }
  } catch (error) {
    closeWindowsHandle(libraries, handle, target);
    if (isAccessDenied(error)) {
      takeObjectOwnership(ffi, libraries, target, sids, kind);
      return requireOwnedObject(ffi, libraries, target, sids, kind);
    }
    throw error;
  }
  closeWindowsHandle(libraries, handle, target);
  takeObjectOwnership(ffi, libraries, target, sids, kind);
  return requireOwnedObject(ffi, libraries, target, sids, kind);
}

function requireSingleFileLinkBeforeRepair(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string
): void {
  const handle = openWindowsPrivateStateObject(
    ffi,
    libraries,
    target,
    FILE_READ_ATTRIBUTES,
    "file",
    FILE_SHARE_ALL
  );
  try {
    requireSingleWindowsFileLink(ffi, libraries, handle, target);
  } finally {
    closeWindowsHandle(libraries, handle, target);
  }
}

function takeObjectOwnership(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string,
  sids: UserSids,
  kind: WindowsPrivateObjectKind
): void {
  const takeOwnership = (): void => {
    const handle = openWindowsPrivateStateObject(
      ffi,
      libraries,
      target,
      FILE_READ_ATTRIBUTES | WRITE_OWNER,
      kind,
      repairShare(kind)
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
          `Could not repair ${target} owner`,
          result
        );
      }
    } finally {
      closeWindowsHandle(libraries, handle, target);
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

function requireOwnedObject(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string,
  sids: UserSids,
  kind: WindowsPrivateObjectKind
): NativeHandle {
  const handle = openOwnedObject(ffi, libraries, target, kind);
  try {
    if (!handleHasOwner(ffi, libraries, handle, sids.user)) {
      throw new Error(
        `Windows private state owner is unsafe: ${target}`
      );
    }
    return handle;
  } catch (error) {
    closeWindowsHandle(libraries, handle, target);
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
  const handle = openWindowsDirectory(
    ffi,
    libraries,
    directory,
    FILE_READ_ATTRIBUTES | READ_CONTROL
  );
  try {
    validateHandleSecurity(
      ffi,
      libraries,
      handle,
      directory,
      sids,
      "directory"
    );
    requireStableWindowsPath(
      ffi,
      libraries,
      directory,
      windowsFileIdentity(ffi, libraries, handle, directory),
      "directory"
    );
  } finally {
    closeWindowsHandle(libraries, handle, directory);
  }
}

function openOwnedObject(
  ffi: BunFfi,
  libraries: WindowsLibraries,
  target: string,
  kind: WindowsPrivateObjectKind
): NativeHandle {
  return openWindowsPrivateStateObject(
    ffi,
    libraries,
    target,
    MAXIMUM_ALLOWED,
    kind,
    repairShare(kind)
  );
}

function repairShare(kind: WindowsPrivateObjectKind): number {
  return kind === "directory" ? FILE_SHARE_REPAIR : FILE_SHARE_ALL;
}
