#!/usr/bin/env -S node --import tsx

import { lstatSync, type Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntime } from "./build-runtime.js";
import { buildShell } from "./build-shell.js";

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Build the source-relative runtime and require the shell build outputs. */
export function buildApp(): void {
  buildRuntime();
  buildShell();
  for (const relative of [
    "main.cjs",
    "desktop/main.js",
    "preload.cjs",
    "renderer/index.html",
    "renderer/renderer.js",
    "renderer/renderer.css",
    "docs/assets/1667-rainbow.svg",
    "LICENSE",
    "NOTICE",
    "server/worker.js",
    "server/image-normalize-child.js",
    "host",
    "client",
    "shared"
  ]) {
    const target = path.join(DESKTOP_ROOT, "app", relative);
    const stat = lstatOrNull(target);
    const directory = relative === "host" || relative === "client" || relative === "shared";
    if (stat === null || stat.isDirectory() !== directory) {
      throw new Error(`Desktop application is missing app/${relative}`);
    }
  }
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) buildApp();
