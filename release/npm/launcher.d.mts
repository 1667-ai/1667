import type { ChildProcess } from "node:child_process";

export const LAUNCHER_RELEASE_TARGETS: Readonly<Record<string, Readonly<{
  packageName: string;
  os: string;
  cpu: string;
  executable: string;
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
