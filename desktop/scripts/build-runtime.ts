#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Compile the Node runtime without changing the source-relative tree. */
export function buildRuntime(): void {
  const appDirectory = path.join(DESKTOP_ROOT, "app");
  mkdirSync(appDirectory, { recursive: true });
  const runtimeDirectories = ["server", "host", "client", "shared"].filter((directory) =>
    isDirectory(path.resolve(DESKTOP_ROOT, "..", directory))
  );
  for (const directory of runtimeDirectories) {
    rmSync(path.join(appDirectory, directory), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    });
  }
  const tsc = path.join(DESKTOP_ROOT, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "--project", path.join(DESKTOP_ROOT, "tsconfig.runtime.json")], {
    cwd: DESKTOP_ROOT,
    stdio: "inherit"
  });
  // `shared/build-identity.ts` imports this manifest at runtime. Keep it next
  // to the compiled source tree so source-relative imports work in asar.
  copyFileSync(path.resolve(DESKTOP_ROOT, "..", "package.json"), path.join(appDirectory, "package.json"));
  for (const name of ["LICENSE", "NOTICE"]) {
    copyFileSync(path.resolve(DESKTOP_ROOT, "..", name), path.join(appDirectory, name));
  }
  for (const directory of runtimeDirectories) {
    const output = path.join(appDirectory, directory);
    if (!isDirectory(output)) throw new Error(`Runtime compiler did not emit app/${directory}`);
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) buildRuntime();
