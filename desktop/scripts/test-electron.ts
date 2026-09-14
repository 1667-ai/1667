#!/usr/bin/env -S node --import tsx

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, "..");
const DEFAULT_TESTS = readdirSync(path.join(REPOSITORY_ROOT, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join("test", name));
const WINDOWS_TESTS = [
  "test/windows-platform-contract.test.ts",
  "test/windows-platform-acl-edge-cases.test.ts",
  "test/release-install-script.test.ts",
  "test/release-install-powershell.test.ts",
  "test/image-normalize.test.ts"
];

/** Run backend integration tests under the Electron Node ABI. */
export function runElectronTests(testFiles = process.argv.slice(2)): void {
  const electron = electronExecutable();
  const imageChild = path.join(REPOSITORY_ROOT, "desktop", "app", "server", "image-normalize-child.js");
  if (!isRegularFile(imageChild)) {
    throw new Error(`Electron image child entry is missing: ${imageChild}`);
  }
  const selected = testFiles.length === 0
    ? process.platform === "win32" ? WINDOWS_TESTS : DEFAULT_TESTS
    : testFiles;
  const result = spawnSync(
    electron,
    ["--import", "tsx", "--import", "./test/setup.ts", "--test", ...selected],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AI_1667_TEST_NODE_EXECUTABLE: process.execPath,
        AI_1667_IMAGE_NORMALIZE_CHILD_ENTRY: imageChild
      },
      stdio: "inherit"
    }
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`Electron test process exited with ${result.status}`);
}

function isRegularFile(value: string): boolean {
  try {
    const stat = lstatSync(value);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function electronExecutable(): string {
  const electronPackage = JSON.parse(readFileSync(
    path.join(DESKTOP_ROOT, "node_modules", "electron", "package.json"),
    "utf8"
  )) as { dist?: string };
  const dist = path.join(DESKTOP_ROOT, "node_modules", "electron", electronPackage.dist ?? "dist");
  if (process.platform === "darwin") return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  return path.join(dist, process.platform === "win32" ? "electron.exe" : "electron");
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) runElectronTests();
