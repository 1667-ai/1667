import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  noFollowFlag,
  sameFileIdentity
} from "./data-directory-file-read.js";

const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;

export interface WindowsPrivateStateRootAdapter {
  /** Must use a platform account API, not an unvalidated process environment. */
  readonly localAppDataDirectory: () => Promise<string>;
  /** Creates/validates a non-inherited current-user + SYSTEM protected DACL. */
  readonly preparePrivateStateRoot: (
    root: string,
    trustedBase?: string
  ) => Promise<string>;
}

export interface PlatformStateRootOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly accountHomeDirectory?: () => string;
  readonly windowsAdapter?: WindowsPrivateStateRootAdapter;
}

export class PlatformStateRootError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlatformStateRootError";
  }
}

type PrivateStateRootPlan =
  | {
      readonly kind: "windows";
      readonly root: string;
      readonly trustedBase: string;
      readonly adapter: WindowsPrivateStateRootAdapter;
    }
  | {
      readonly kind: "darwin";
      readonly root: string;
      readonly accountHome: string;
    }
  | {
      readonly kind: "linux-xdg";
      readonly root: string;
      readonly trustedBase: string;
    }
  | {
      readonly kind: "linux-default";
      readonly root: string;
      readonly accountHome: string;
    };

/**
 * Resolve and prepare the private application state root.
 *
 * POSIX has a concrete no-follow owner/mode implementation. Windows requires
 * an adapter capable of inspecting DACLs and reparse points; absent that
 * capability it fails closed.
 */
export async function resolvePrivatePlatformStateRoot(
  options: PlatformStateRootOptions = {}
): Promise<string> {
  const plan = await privateStateRootPlan(options);
  if (plan.kind === "windows") {
    const prepared = await plan.adapter.preparePrivateStateRoot(
      plan.root,
      plan.trustedBase
    );
    if (prepared !== plan.root) {
      throw new PlatformStateRootError(
        "Windows state adapter returned a different or non-canonical root"
      );
    }
    return prepared;
  }
  if (plan.kind === "darwin") {
    const applicationSupport = path.posix.join(
      plan.accountHome,
      "Library",
      "Application Support"
    );
    // Created, not merely required. macOS ships this directory, so demanding it
    // held everywhere a real account runs and failed only where one does not:
    // a fixture HOME, a freshly created account, a sandboxed environment. Linux
    // already creates its own equivalent below, and each component still passes
    // the same canonical, non-symlink check either way.
    await ensureCanonicalDirectoryChain(
      plan.accountHome,
      ["Library", "Application Support"]
    );
    return await preparePrivateChain(applicationSupport, ["1667", "State"]);
  }
  if (plan.kind === "linux-xdg") {
    return await preparePrivateChain(plan.trustedBase, ["1667"]);
  }
  const defaultStateBase = path.posix.join(
    plan.accountHome,
    ".local",
    "state"
  );
  await ensureCanonicalDirectoryChain(
    plan.accountHome,
    [".local", "state"]
  );
  return await preparePrivateChain(defaultStateBase, ["1667"]);
}

/** Resolves the state-root path without creating or changing the path. */
export async function resolvePrivatePlatformStateRootPath(
  options: PlatformStateRootOptions = {}
): Promise<string> {
  return (await privateStateRootPlan(options)).root;
}

export async function inspectPrivatePosixDirectory(
  directory: string,
  label = "Application state root"
): Promise<Stats> {
  const pathInfo = await lstat(directory);
  requirePrivatePosixDirectory(pathInfo, directory, label);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | DIRECTORY_FLAG | noFollowFlag()
    );
    const handleInfo = await handle.stat();
    requirePrivatePosixDirectory(handleInfo, directory, label);
    if (!sameFileIdentity(pathInfo, handleInfo)) {
      throw new PlatformStateRootError(`${label} identity changed: ${directory}`);
    }
    const canonical = await realpath(directory);
    if (canonical !== directory) {
      throw new PlatformStateRootError(`${label} is not canonical: ${directory}`);
    }
    return handleInfo;
  } finally {
    await handle?.close();
  }
}

async function privateStateRootPlan(
  options: PlatformStateRootOptions
): Promise<PrivateStateRootPlan> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return await windowsStateRootPlan(options);
  if (platform !== "linux" && platform !== "darwin") {
    throw new PlatformStateRootError(
      `Application state is unsupported on platform ${platform}`
    );
  }
  const getHome = options.accountHomeDirectory ?? homedir;
  const accountHome = await canonicalAccountHome(getHome());
  if (platform === "darwin") {
    return {
      kind: "darwin",
      accountHome,
      root: path.posix.join(
        accountHome,
        "Library",
        "Application Support",
        "1667",
        "State"
      )
    };
  }
  const environment = options.environment ?? process.env;
  const override = environment.XDG_STATE_HOME;
  if (override !== undefined && override !== "") {
    requireCanonicalAbsolute(override, path.posix, "XDG_STATE_HOME");
    await inspectPrivatePosixDirectory(override, "XDG_STATE_HOME");
    return {
      kind: "linux-xdg",
      trustedBase: override,
      root: path.posix.join(override, "1667")
    };
  }
  return {
    kind: "linux-default",
    accountHome,
    root: path.posix.join(accountHome, ".local", "state", "1667")
  };
}

async function windowsStateRootPlan(
  options: PlatformStateRootOptions
): Promise<Extract<PrivateStateRootPlan, { kind: "windows" }>> {
  const adapter = options.windowsAdapter
    ?? (process.platform === "win32"
      ? await defaultWindowsPrivateStateRootAdapter()
      : undefined);
  if (adapter === undefined) {
    throw new PlatformStateRootError(
      "Application state needs a Windows DACL/reparse-safe platform adapter"
    );
  }
  const localAppData = await adapter.localAppDataDirectory();
  requireCanonicalAbsolute(localAppData, path.win32, "Windows LocalAppData");
  return {
    kind: "windows",
    adapter,
    trustedBase: localAppData,
    root: path.win32.join(localAppData, "1667", "State")
  };
}

async function defaultWindowsPrivateStateRootAdapter(): Promise<
  WindowsPrivateStateRootAdapter
> {
  const { createWindowsPrivateStateRootAdapter } = await import(
    "./platform-state-root-windows.js"
  );
  return createWindowsPrivateStateRootAdapter();
}

async function canonicalAccountHome(home: string): Promise<string> {
  requireCanonicalAbsolute(home, path.posix, "Account home");
  const canonical = await realpath(home);
  requireCanonicalAbsolute(canonical, path.posix, "Account home");
  await requireCanonicalDirectory(canonical, "Account home");
  return canonical;
}

async function ensureCanonicalDirectoryChain(
  trustedRoot: string,
  components: readonly string[]
): Promise<void> {
  let cursor = trustedRoot;
  for (const component of components) {
    const next = path.posix.join(cursor, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    await requireCanonicalDirectory(next, "Application state ancestor");
    cursor = next;
  }
}

async function preparePrivateChain(
  trustedRoot: string,
  components: readonly string[]
): Promise<string> {
  let cursor = trustedRoot;
  for (const component of components) {
    const next = path.posix.join(cursor, component);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    await inspectPrivatePosixDirectory(next);
    cursor = next;
  }
  return cursor;
}

async function requireCanonicalDirectory(
  directory: string,
  label: string
): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PlatformStateRootError(`${label} is not a directory: ${directory}`);
  }
  const canonical = await realpath(directory);
  if (canonical !== directory) {
    throw new PlatformStateRootError(`${label} is not canonical: ${directory}`);
  }
}

function requirePrivatePosixDirectory(
  info: Stats,
  directory: string,
  label: string
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PlatformStateRootError(
      `${label} is not a private directory: ${directory}`
    );
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw new PlatformStateRootError(
      `${label} permissions are not 0700: ${directory}`
    );
  }
  if (
    typeof process.geteuid === "function"
    && info.uid !== process.geteuid()
  ) {
    throw new PlatformStateRootError(
      `${label} is not owned by the effective user: ${directory}`
    );
  }
}

function requireCanonicalAbsolute(
  value: string,
  implementation: path.PlatformPath,
  label: string
): void {
  if (
    typeof value !== "string"
    || !implementation.isAbsolute(value)
    || implementation.normalize(value) !== value
    || implementation.resolve(value) !== value
  ) {
    throw new PlatformStateRootError(
      `${label} must be an absolute canonical path`
    );
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
