import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRODUCTION_ROOTS = ["server", "tui/src"] as const;
const RAW_LOCK_IMPORT = /from\s+["'][^"']*data-directory-lock\.js["']/;
const ALLOWED_RAW_IMPORTS = [
  "server/data-directory-migration.ts",
  "server/runtime-data-directory.ts",
  // Vault lifecycle commands must lock format 5 before a Vault Key exists.
  "server/vault-lifecycle.ts"
];

test("production runtime code cannot bypass prepared data-directory acquisition", async () => {
  const rawImports: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const file of await typescriptFiles(path.join(ROOT, root))) {
      if (RAW_LOCK_IMPORT.test(await readFile(file, "utf8"))) {
        rawImports.push(path.relative(ROOT, file).split(path.sep).join("/"));
      }
    }
  }

  assert.deepEqual(rawImports.sort(), ALLOWED_RAW_IMPORTS);
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(target);
  }
  return files;
}
