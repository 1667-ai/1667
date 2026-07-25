import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
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
  if (configured === undefined || configured === "") {
    return await resolvePrivatePlatformStateRoot(
      options.platform === undefined ? {} : { platform }
    );
  }
  return await prepareOverride(configured, platform);
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
  await mkdir(configured, { recursive: true, mode: 0o700 });
  // A canonical path is what the privacy inspection compares against, and
  // temporary roots are commonly reached through a symlinked ancestor.
  const canonical = await realpath(configured);
  if (platform !== "win32") await inspectPrivatePosixDirectory(canonical);
  return canonical;
}
