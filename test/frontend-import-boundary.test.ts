import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
// Every form that creates a module edge: `import … from`, `export … from`,
// a bare side-effect `import "…"`, and a dynamic `import("…")`.
const IMPORT_SOURCE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

test("the scanner sees static, re-export, side-effect, and dynamic imports", () => {
  const source = [
    'import { a } from "./static.js";',
    'export * from "./reexport.js";',
    'import "./side-effect.js";',
    'const b = await import("./dynamic.js");',
    'const c = await import(\n  "./dynamic-wrapped.js"\n);'
  ].join("\n");
  assert.deepEqual(
    [...source.matchAll(IMPORT_SOURCE)].map((match) => match[1]),
    ["./static.js", "./reexport.js", "./side-effect.js", "./dynamic.js", "./dynamic-wrapped.js"]
  );
});

test("tui/ never imports anything under cli/", async () => {
  const violations = await importsMatching("tui", (target) => underDirectory(target, "cli"));
  assert.deepEqual(violations, []);
});

test("cli/src reaches tui/ only through its facade and its update-channel exception", async () => {
  const ALLOWED_TUI_IMPORTS = ["tui/src/index.js", "tui/src/config.js"];
  const violations = await importsMatching("cli/src", (target) =>
    underDirectory(target, "tui") && !ALLOWED_TUI_IMPORTS.includes(target));
  assert.deepEqual(violations, []);
});

// host/, client/, server/, and shared/ are the foundation cli/ and tui/ are
// built from, so none of them has ever needed to import either one. No entry
// belongs in this list; a new one would mean a shared directory started
// reaching upward into a frontend.
const ALLOWED_CORE_FRONTEND_IMPORTS: readonly string[] = [];

test("host, client, server, and shared do not import tui/ or cli/", async () => {
  const violations: string[] = [];
  for (const root of ["host", "client", "server", "shared"]) {
    violations.push(...await importsMatching(root, (target) =>
      underDirectory(target, "tui") || underDirectory(target, "cli")));
  }
  assert.deepEqual(
    violations.filter((entry) => !ALLOWED_CORE_FRONTEND_IMPORTS.includes(entry)),
    []
  );
});

/** `target` is a repository-relative path with forward slashes. */
function underDirectory(target: string, directory: string): boolean {
  return target === directory || target.startsWith(`${directory}/`);
}

async function importsMatching(
  root: string,
  matches: (target: string) => boolean
): Promise<string[]> {
  const violations: string[] = [];
  for (const file of await typescriptFiles(path.join(ROOT, root))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_SOURCE)) {
      const specifier = match[1]!;
      // Bare package names never point into this repository's frontends.
      if (!specifier.startsWith(".")) continue;
      const target = path.relative(ROOT, path.resolve(path.dirname(file), specifier))
        .split(path.sep).join("/");
      if (matches(target)) {
        violations.push(`${path.relative(ROOT, file).split(path.sep).join("/")} -> ${specifier}`);
      }
    }
  }
  return violations;
}

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...await typescriptFiles(target));
    }
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}
