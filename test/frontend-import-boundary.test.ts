import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const IMPORT_SOURCE = /from\s+["']([^"']+)["']/g;

test("tui/ never imports anything under cli/", async () => {
  const violations = await importsMatching("tui", (specifier) => underDirectory(specifier, "cli"));
  assert.deepEqual(violations, []);
});

test("cli/src reaches tui/ only through its facade and its update-channel exception", async () => {
  const ALLOWED_TUI_IMPORTS = ["tui/src/index.js", "tui/src/config.js"];
  const violations = await importsMatching("cli/src", (specifier) => {
    if (!underDirectory(specifier, "tui")) return false;
    return !ALLOWED_TUI_IMPORTS.some((allowed) => specifier.endsWith(allowed));
  });
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
    violations.push(...await importsMatching(root, (specifier) =>
      underDirectory(specifier, "tui") || underDirectory(specifier, "cli")));
  }
  assert.deepEqual(
    violations.filter((entry) => !ALLOWED_CORE_FRONTEND_IMPORTS.includes(entry)),
    []
  );
});

function underDirectory(specifier: string, directory: string): boolean {
  return specifier === directory
    || specifier.startsWith(`${directory}/`)
    || specifier.includes(`/${directory}/`);
}

async function importsMatching(
  root: string,
  matches: (specifier: string) => boolean
): Promise<string[]> {
  const violations: string[] = [];
  for (const file of await typescriptFiles(path.join(ROOT, root))) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_SOURCE)) {
      const specifier = match[1]!;
      if (matches(specifier)) {
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
    if (entry.isDirectory()) files.push(...await typescriptFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}
