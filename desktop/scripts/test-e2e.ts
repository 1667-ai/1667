#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tests = readdirSync(path.join(desktopRoot, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => path.join("test", name));
if (tests.length === 0) throw new Error("No desktop tests were found.");

execFileSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...tests], {
  cwd: desktopRoot,
  stdio: "inherit"
});
