import { chmod, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertNoDarwinExtendedAllow
} from "./machine-tier-privacy-darwin.js";
import {
  inspectPrivatePosixDirectory,
  PlatformStateRootError,
  resolvePrivatePlatformStateRoot,
  resolvePrivatePlatformStateRootPath,
  type PlatformStateRootOptions,
  type WindowsPrivateStateRootAdapter
} from "./platform-state-root.js";
import {
  MACHINE_TIER_OVERRIDE_VARIABLE
} from "../shared/machine-tier-environment.js";

export {
  MACHINE_TIER_OVERRIDE_VARIABLE
} from "../shared/machine-tier-environment.js";

/**
 * The machine tier: the one directory 1667 creates itself on this machine.
 * It holds provider secrets and HTTP auth records, so the strict privacy
 * assertions removed from the project tier keep holding here.
 */
export interface MachineTierOptions {
  readonly override?: string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly windowsAdapter?: WindowsPrivateStateRootAdapter;
}

export async function resolveMachineTierRoot(
  options: MachineTierOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const configured = options.override
    ?? environment[MACHINE_TIER_OVERRIDE_VARIABLE];
  const root = configured === undefined || configured === ""
    ? await resolvePrivatePlatformStateRoot(
        platformStateRootOptions(options, platform)
      )
    : await prepareOverride(configured, platform, options.windowsAdapter);
  // Mode 0700 does not revoke an inherited macOS ACL, and this directory holds
  // the keys. Packaged Darwin builds prove there is no extended allow entry.
  if (platform === "darwin") {
    await assertNoDarwinExtendedAllow(root, "1667 machine state root");
  }
  return root;
}

/** Resolves the machine-tier path without creating or changing the path. */
export async function resolveMachineTierRootPath(
  options: MachineTierOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const configured = options.override
    ?? environment[MACHINE_TIER_OVERRIDE_VARIABLE];
  if (configured !== undefined && configured !== "") {
    return requireAbsoluteOverride(configured, platform);
  }
  return await resolvePrivatePlatformStateRootPath(
    platformStateRootOptions(options, platform)
  );
}

async function prepareOverride(
  configured: string,
  platform: NodeJS.Platform,
  windowsAdapter: WindowsPrivateStateRootAdapter | undefined
): Promise<string> {
  requireAbsoluteOverride(configured, platform);
  if (platform === "win32") {
    const adapter = windowsAdapter
      ?? (process.platform === "win32"
        ? await defaultWindowsPrivateStateRootAdapter()
        : undefined);
    if (adapter === undefined) {
      throw new PlatformStateRootError(
        `${MACHINE_TIER_OVERRIDE_VARIABLE} needs a Windows DACL/reparse-safe `
          + "platform adapter before 1667 can store secrets there"
      );
    }
    const prepared = await adapter.preparePrivateStateRoot(configured);
    if (prepared !== configured) {
      throw new PlatformStateRootError(
        `${MACHINE_TIER_OVERRIDE_VARIABLE} adapter returned a different root`
      );
    }
    return prepared;
  }
  await mkdir(configured, { recursive: true, mode: 0o700 });
  // A canonical path is what the privacy inspection compares against, and
  // temporary roots are commonly reached through a symlinked ancestor.
  const canonical = await realpath(configured);
  // This directory holds the keys, so 1667 makes it private rather than
  // refusing an override that merely arrived with a wider mode. Ownership is
  // still asserted by the inspection below.
  await chmod(canonical, 0o700);
  await inspectPrivatePosixDirectory(canonical);
  return canonical;
}

function requireAbsoluteOverride(
  configured: string,
  platform: NodeJS.Platform
): string {
  const implementation = platform === "win32" ? path.win32 : path.posix;
  if (!implementation.isAbsolute(configured)) {
    throw new PlatformStateRootError(
      `${MACHINE_TIER_OVERRIDE_VARIABLE} must be an absolute path: ${configured}`
    );
  }
  return configured;
}

function platformStateRootOptions(
  options: MachineTierOptions,
  platform: NodeJS.Platform
): PlatformStateRootOptions {
  return {
    platform,
    ...(options.environment === undefined
      ? {}
      : { environment: options.environment }),
    ...(options.windowsAdapter === undefined
      ? {}
      : { windowsAdapter: options.windowsAdapter })
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
