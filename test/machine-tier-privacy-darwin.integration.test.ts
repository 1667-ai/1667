import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertNoDarwinExtendedAllow
} from "../server/machine-tier-privacy-darwin.js";

const execFileAsync = promisify(execFile);

test("Node Darwin privacy proof rejects inherited allow ACL entries", {
  skip: process.platform !== "darwin" || process.versions.bun !== undefined
}, async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "1667-darwin-acl-"));
  t.after(async () => {
    try {
      await execFileAsync("chmod", ["-RN", parent]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  try {
    await execFileAsync("chmod", [
      "+a",
      "everyone allow read,file_inherit,directory_inherit",
      parent
    ]);
  } catch {
    t.skip("the test volume does not support macOS ACLs");
    return;
  }
  const root = path.join(parent, "state");
  await mkdir(root);

  await assert.rejects(
    assertNoDarwinExtendedAllow(root, "1667 machine state root"),
    /unsupported Darwin extended ACL/u
  );
});
