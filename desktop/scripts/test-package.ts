#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageDesktopRelease, verifyDesktopTargetAssetDirectory } from "../../scripts/release-desktop-assets.js";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(tmpdir(), "1667-desktop-package-"));
const output = path.join(temporary, "raw");
const builder = path.join(desktopRoot, "node_modules", "electron-builder", "cli.js");
const args = [
  builder, "--config", "electron-builder.yml", "--publish", "never",
  `--config.directories.output=${output}`
];
let executable: string;
if (process.platform === "darwin") {
  // CI checks unsigned DMG and ZIP output. Release packaging requires the
  // Developer ID signature and notarization from electron-builder.yml.
  args.push("--mac", "dmg", "zip", "--config.mac.identity=null", "--config.mac.forceCodeSigning=false",
    "--config.mac.notarize=false");
  executable = path.join(output, process.arch === "arm64" ? "mac-arm64" : "mac",
    "1667.app", "Contents", "MacOS", "1667");
} else if (process.platform === "win32") {
  args.push("--win", "--dir");
  executable = path.join(output, "win-unpacked", "1667.exe");
} else if (process.platform === "linux") {
  args.push("--linux", "--dir");
  executable = path.join(output, process.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked", "1667");
} else {
  throw new Error(`Unsupported desktop platform: ${process.platform}`);
}
args.push(process.arch === "arm64" ? "--arm64" : "--x64");
try {
  execFileSync(process.execPath, args, {
    cwd: desktopRoot,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" }
  });
  if (process.platform === "darwin") {
    const target = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    const { version } = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")) as { version: string };
    const staged = path.join(temporary, "staged");
    stageDesktopRelease({ version, target, sourceDirectory: output, outputDirectory: staged });
    verifyDesktopTargetAssetDirectory(staged, version, target);
  }
  execFileSync(process.execPath, [
    "--import", "tsx", "--test", "test/desktop-client-contract.e2e.test.ts"
  ], {
    cwd: desktopRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      AI_1667_DESKTOP_APP_PATH: path.join(desktopRoot, "app", "main.cjs"),
      AI_1667_DESKTOP_EXECUTABLE: executable
    }
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
