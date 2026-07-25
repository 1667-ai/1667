import { chmod, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertNoDarwinExtendedAllow
} from "./machine-tier-privacy-darwin.js";
import {
  inspectPrivatePosixDirectory,
  PlatformStateRootError,
  resolvePrivatePlatformStateRoot
} from "./platform-state-root.js";

/**
 * ADR007 machine tier: the one directory 1667 creates itself on this machine.
 * It holds provider secrets and HTTP auth records, so the strict privacy
 * assertions removed from the project tier keep holding here.
 */
export interface MachineTierOptions {
  readonly override?: string | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export const MACHINE_TIER_OVERRIDE_VARIABLE = "AI_1667_STATE";

export async function resolveMachineTierRoot(
  options: MachineTierOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const configured = options.override
    ?? environment[MACHINE_TIER_OVERRIDE_VARIABLE];
  const root = configured === undefined || configured === ""
    ? await resolvePrivatePlatformStateRoot(
        options.platform === undefined ? {} : { platform }
      )
    : await prepareOverride(configured, platform);
  // Mode 0700 does not revoke an inherited macOS ACL, and this directory holds
  // the keys. Packaged Darwin builds prove there is no extended allow entry.
  if (platform === "darwin") {
    await assertNoDarwinExtendedAllow(root, "1667 machine state root");
  }
  return root;
}

async function prepareOverride(
  configured: string,
  platform: NodeJS.Platform
): Promise<string> {
  const implementation = platform === "win32" ? path.win32 : path.posix;
  if (!implementation.isAbsolute(configured)) {
    throw new PlatformStateRootError(
      `${MACHINE_TIER_OVERRIDE_VARIABLE} must be an absolute path: ${configured}`
    );
  }
  if (platform === "win32") {
    // An override cannot be validated without the DACL/reparse-safe adapter the
    // default path already requires, and this directory holds provider keys.
    // Accepting one would put them somewhere 1667 cannot prove is private.
    throw new PlatformStateRootError(
      `${MACHINE_TIER_OVERRIDE_VARIABLE} needs a Windows DACL/reparse-safe `
        + "platform adapter before 1667 can store secrets there"
    );
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
