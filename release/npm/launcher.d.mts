import type { ChildProcess } from "node:child_process";

export const LAUNCHER_PACKAGE_NAME: "@1667-ai/cli";
export const LAUNCHER_SOURCE_URL: "https://github.com/1667-ai/1667";
export type LauncherReleaseTarget = Readonly<{
  packageName:
    | "@1667-ai/darwin-arm64"
    | "@1667-ai/darwin-x64"
    | "@1667-ai/linux-arm64"
    | "@1667-ai/linux-x64"
    | "@1667-ai/windows-x64";
  os: "darwin" | "linux" | "win32";
  cpu: "arm64" | "x64";
  libc: "glibc" | null;
  executable: "bin/1667" | "bin/1667.exe";
  minimumCpuFeature: "sse4.2" | null;
  minimumMacosVersion: "13.0" | null;
  minimumGlibcVersion: "2.17" | null;
  heldFromPublication: string | null;
}>;
export const LAUNCHER_RELEASE_TARGETS: Readonly<Record<string, LauncherReleaseTarget>>;

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

export interface HostCompatibilityObservation {
  cpuSupportsSse42: boolean | null;
  macosVersion: string | null;
  glibcVersion: string | null;
}

export type HostCompatibilityObserver = (
  target: string
) => HostCompatibilityObservation;

export function resolveLaunchPlan(options?: LaunchOptions): LaunchPlan;
export function prepareLaunch(
  options?: LaunchOptions,
  observeHost?: HostCompatibilityObserver
): LaunchPlan;
export function selectTarget(platform: string, arch: string): string;
export function heldTargetRefusal(
  target: string,
  policy: LauncherReleaseTarget
): string;
export function assertHostCompatibility(
  target: string,
  policy: LauncherReleaseTarget,
  observation: HostCompatibilityObservation
): void;
export function linuxCpuSupportsSse42(cpuInfo: string): boolean | null;
export function linuxCpuFileSupportsSse42(file: string): boolean | null;
export function darwinCpuSupportsSse42(
  features: string | null,
  arm64Capability: string | null
): boolean | null;
export function runLauncher(
  options?: LaunchOptions,
  observeHost?: HostCompatibilityObserver
): ChildProcess;
