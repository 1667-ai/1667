#!/usr/bin/env -S node --import tsx

import { buildSync } from "esbuild";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(DESKTOP_ROOT, "..");
const APP_ROOT = path.join(DESKTOP_ROOT, "app");
const SHELL_ROOT = path.join(APP_ROOT, "desktop");
const RENDERER_ROOT = path.join(APP_ROOT, "renderer");

/** Compile the Electron shell and copy its browser assets into the app tree. */
export function buildShell(): void {
  const source = (name: string): string => requireSource(path.join(DESKTOP_ROOT, name));
  source("main.ts");
  const shellEntries = readdirSync(DESKTOP_ROOT)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts")
      && !name.startsWith("renderer") && name !== "preload.ts")
    .map(source);
  const preload = source("preload.ts");
  const renderer = source("renderer.ts");
  const html = source("index.html");
  const css = source("renderer.css");
  const mark = requireSource(path.join(REPOSITORY_ROOT, "docs", "assets", "1667-rainbow.svg"));

  rmSync(SHELL_ROOT, { recursive: true, force: true });
  rmSync(RENDERER_ROOT, { recursive: true, force: true });
  for (const generated of ["main.cjs", "preload.cjs"]) {
    rmSync(path.join(APP_ROOT, generated), { force: true });
  }
  mkdirSync(SHELL_ROOT, { recursive: true });
  mkdirSync(RENDERER_ROOT, { recursive: true });
  mkdirSync(path.join(APP_ROOT, "docs", "assets"), { recursive: true });

  // Keep the main process as source-relative ESM. Host worker and image URLs
  // use import.meta.url, so bundling them would change their runtime paths.
  buildSync({
    entryPoints: shellEntries,
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node20",
    outdir: SHELL_ROOT,
    sourcemap: true,
    logLevel: "warning"
  });
  // Electron's sandboxed preload is a CommonJS script. Bundle its small
  // shared protocol dependency while leaving Electron's API external.
  buildSync({
    entryPoints: [preload],
    bundle: true,
    external: ["electron"],
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: path.join(APP_ROOT, "preload.cjs"),
    sourcemap: true,
    logLevel: "warning"
  });
  buildSync({
    entryPoints: [renderer],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: path.join(RENDERER_ROOT, "renderer.js"),
    sourcemap: true,
    logLevel: "warning"
  });

  copyFileSync(html, path.join(RENDERER_ROOT, "index.html"));
  copyFileSync(css, path.join(RENDERER_ROOT, "renderer.css"));
  copyFileSync(mark, path.join(APP_ROOT, "docs", "assets", "1667-rainbow.svg"));
  writeFileSync(path.join(APP_ROOT, "main.cjs"), MAIN_ENTRY, "utf8");
}

function requireSource(value: string): string {
  try {
    readFileSync(value);
    return value;
  } catch {
    throw new Error(`Desktop shell source is missing ${path.relative(DESKTOP_ROOT, value)}`);
  }
}

const MAIN_ENTRY = [
  `// Electron's package entry remains CommonJS while the main process keeps ESM paths.\n`,
  ["im", "port"].join("") + `("./desktop/main.js").catch((error) => {\n`,
  `  console.error(error);\n`,
  `  process.exitCode = 1;\n`,
  `});\n`
].join("");

function isMainModule(): boolean {
  return process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) buildShell();
