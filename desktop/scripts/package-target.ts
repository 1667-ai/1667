#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
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
  if (target.startsWith("darwin-")) requireMacSigningEnvironment();
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

function assertApplicationFiles(): void {
  const required = [
    "main.cjs",
    "preload.cjs",
    "renderer/index.html",
    "renderer/renderer.js",
    "renderer/renderer.css",
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
      const directory = relative === "host" || relative === "client" || relative === "shared";
      if (directory ? !stat.isDirectory() : stat.isDirectory()) {
        throw new Error(`Desktop application path has the wrong type: app/${relative}`);
      }
    } catch {
      throw new Error(`Desktop application is missing app/${relative}`);
    }
  }
}

function requireMacSigningEnvironment(): void {
  const hasCertificate = nonEmpty(process.env.CSC_LINK) || nonEmpty(process.env.CSC_NAME);
  if (!hasCertificate || !nonEmpty(process.env.APPLE_ID)
    || !nonEmpty(process.env.APPLE_APP_SPECIFIC_PASSWORD)
    || !nonEmpty(process.env.APPLE_TEAM_ID)) {
    throw new Error(
      "Mac desktop release requires CSC_LINK or CSC_NAME, APPLE_ID, "
      + "APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID"
    );
  }
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
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
