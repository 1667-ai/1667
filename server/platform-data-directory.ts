import os from "node:os";
import path from "node:path";
import { ServiceError } from "./errors.js";

export interface PlatformDataDirectoryOptions {
  readonly configured?: string;
  readonly packaged?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Resolves application data independently from auth/state and package bytes. */
export function resolvePlatformDataDirectory(
  options: PlatformDataDirectoryOptions = {}
): string {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configured = options.configured;
  if (configured !== undefined) {
    if (configured.length === 0) {
      throw new ServiceError(
        400,
        "1667 data override must not be empty",
        "invalid_request"
      );
    }
    // A relative override is ordinary. `1667 --data book` resolves
    // against the working directory on every build, packaged included.
    return pathFor(platform).resolve(cwd, configured);
  }
  if (options.packaged !== true) {
    return pathFor(platform).resolve(cwd, "data");
  }

  const home = options.home ?? os.homedir();
  if (!pathFor(platform).isAbsolute(home)) {
    throw unavailable("1667 could not resolve the current account home");
  }
  if (platform === "darwin") {
    return path.posix.join(
      home,
      "Library",
      "Application Support",
      "1667",
      "Data",
      "default"
    );
  }
  if (platform === "linux") {
    const xdg = env.XDG_DATA_HOME;
    const root = xdg === undefined || xdg.length === 0
      ? path.posix.join(home, ".local", "share")
      : requireAbsolute(path.posix, xdg, "XDG_DATA_HOME");
    return path.posix.join(root, "1667", "default");
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local === undefined || local.length === 0) {
      throw unavailable("Windows did not provide LOCALAPPDATA");
    }
    return path.win32.join(
      requireAbsolute(path.win32, local, "LOCALAPPDATA"),
      "1667",
      "Data",
      "default"
    );
  }
  throw unavailable(`1667 data roots are unsupported on ${platform}`);
}

function pathFor(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function requireAbsolute<P extends typeof path.posix | typeof path.win32>(
  implementation: P,
  value: string,
  label: string
): string {
  if (!implementation.isAbsolute(value)) {
    throw unavailable(`${label} must be absolute`);
  }
  return implementation.normalize(value);
}

function unavailable(message: string): ServiceError {
  return new ServiceError(500, message, "internal");
}
