import type { ChildProcess } from "node:child_process";

export const LAUNCHER_PACKAGE_NAME: "@1667-ai/cli";
export const LAUNCHER_RELEASE_TARGETS: Readonly<Record<string, Readonly<{
  packageName:
    | "@1667-ai/darwin-arm64"
    | "@1667-ai/darwin-x64"
    | "@1667-ai/linux-arm64"
    | "@1667-ai/linux-x64";
  os: "darwin" | "linux";
  cpu: "arm64" | "x64";
  libc: "glibc" | null;
  executable: "bin/1667";
}>>>;

export interface LaunchPlan {
  launcherRoot: string;
  platformRoot: string;
  executable: string;
  args: readonly string[];
  target: string;
  packageName: string;
  productVersion: string;
  sourceCommit: string;
}

export interface LaunchOptions {
  launcherRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  args?: readonly string[];
}

export function resolveLaunchPlan(options?: LaunchOptions): LaunchPlan;
export function selectTarget(platform: string, arch: string): string;
export function runLauncher(options?: LaunchOptions): ChildProcess;
