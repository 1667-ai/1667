#!/usr/bin/env -S node --import tsx

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stageDesktopRelease,
  type DesktopReleaseTarget
} from "../../scripts/release-desktop-assets.js";
import { buildRuntime } from "./build-runtime.js";

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS: readonly DesktopReleaseTarget[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "windows-x64"
];

export function packageTarget(target: DesktopReleaseTarget): void {
  if (!TARGETS.includes(target)) throw new Error(`Unsupported desktop release target ${target}`);
  const version = packageVersion();
  buildRuntime();
  assertApplicationFiles();
  const rawDirectory = path.join(DESKTOP_ROOT, "dist", "raw");
  const builder = path.join(
    DESKTOP_ROOT,
    "node_modules",
    "electron-builder",
    "cli.js"
  );
  const builderArgs = ["--config", path.join(DESKTOP_ROOT, "electron-builder.yml"), "--publish", "never"];
  if (target.startsWith("darwin-")) {
    builderArgs.push("--mac", "dmg", "zip", target.endsWith("arm64") ? "--arm64" : "--x64");
  } else if (target.startsWith("linux-")) {
    builderArgs.push("--linux", "AppImage", target.endsWith("arm64") ? "--arm64" : "--x64");
  } else {
    builderArgs.push("--win", "nsis", "--x64");
  }
  execFileSync(process.execPath, [builder, ...builderArgs], { cwd: DESKTOP_ROOT, stdio: "inherit" });
  if (target.startsWith("darwin-")) {
    const application = path.join(
      rawDirectory,
      target.endsWith("arm64") ? "mac-arm64" : "mac",
      "1667.app"
    );
    assertAnonymousMacSignature(application);
  }
  const outputDirectory = process.env.DESKTOP_ASSET_OUTPUT
    ?? path.join(DESKTOP_ROOT, "dist", "desktop");
  stageDesktopRelease({
    version,
    target,
    sourceDirectory: rawDirectory,
    outputDirectory,
    repository: process.env.GITHUB_REPOSITORY ?? "1667-ai/1667"
  });
}

export function assertAnonymousMacSignature(application: string): void {
  const display = runCodesign(["--display", "--verbose=4"], application);
  if (display.status !== 0) {
    throw new Error(`Mac application signature inspection failed:\n${display.output}`);
  }
  if (!/^Signature=adhoc$/mu.test(display.output)
    || !/^TeamIdentifier=not set$/mu.test(display.output)
    || /^Authority=/mu.test(display.output)) {
    throw new Error(`Mac application does not have an anonymous ad-hoc signature:\n${display.output}`);
  }
  const verify = runCodesign(["--verify", "--strict", "--verbose=2"], application);
  if (verify.status !== 0) {
    throw new Error(`Mac application signature verification failed:\n${verify.output}`);
  }
}

function runCodesign(args: string[], application: string): { status: number | null; output: string } {
  const result = spawnSync("/usr/bin/codesign", [...args, application], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`.trim() };
}

function assertApplicationFiles(): void {
  const required = [
    "main.cjs",
    "preload.cjs",
    "renderer/index.html",
    "renderer/renderer.js",
    "renderer/renderer.css",
    "renderer/fonts",
    "server/worker.js",
    "server/image-normalize-child.js",
    "host",
    "client",
    "shared"
  ];
  for (const relative of required) {
    const file = path.join(DESKTOP_ROOT, "app", relative);
    try {
      const stat = lstatSync(file);
      const directory = relative === "host" || relative === "client" || relative === "shared"
        || relative === "renderer/fonts";
      if (directory ? !stat.isDirectory() : stat.isDirectory()) {
        throw new Error(`Desktop application path has the wrong type: app/${relative}`);
      }
    } catch {
      throw new Error(`Desktop application is missing app/${relative}`);
    }
  }
}

function packageVersion(): string {
  const value: unknown = (JSON.parse(
    readFileSync(path.join(DESKTOP_ROOT, "package.json"), "utf8")
  ) as { version?: unknown }).version;
  if (typeof value !== "string") throw new Error("Desktop package version is invalid");
  const expected = process.env.DESKTOP_VERSION;
  if (expected !== undefined && value !== expected) {
    throw new Error(`Desktop package version ${value} does not match release version ${expected}`);
  }
  return value;
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const target = process.argv[2] as DesktopReleaseTarget | undefined;
  if (target === undefined || process.argv.length !== 3) {
    throw new Error(`usage: package-target.ts <${TARGETS.join("|")}>`);
  }
  packageTarget(target);
}
