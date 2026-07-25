import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeDataDirectoryLock } from "../server/runtime-data-directory.js";

test("Linux storage authority remains on the retained directory after replacement", {
  skip: process.platform !== "linux"
}, async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "1667-authority-"));
  await chmod(parent, 0o700);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "data");
  const moved = path.join(parent, "moved");
  const lock = new RuntimeDataDirectoryLock(target);
  await lock.acquire();
  t.after(() => lock.release());

  await rename(target, moved);
  await mkdir(target, { mode: 0o700 });
  await writeFile(path.join(lock.authorityPath, "retained.txt"), "retained");
  await writeFile(path.join(target, "replacement.txt"), "replacement");

  assert.equal(await readFile(path.join(moved, "retained.txt"), "utf8"), "retained");
  await assert.rejects(readFile(path.join(target, "retained.txt")), /ENOENT/);
});

test("Darwin storage authority remains a traversable canonical directory", {
  skip: process.platform !== "darwin"
}, async (t) => {
  const target = await mkdtemp(path.join(os.tmpdir(), "1667-darwin-authority-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  const lock = new RuntimeDataDirectoryLock(target);
  await lock.acquire();
  t.after(() => lock.release());

  assert.equal(lock.authorityPath, await realpath(target));
  await writeFile(path.join(lock.authorityPath, "child.txt"), "reachable");
  assert.equal(await readFile(path.join(target, "child.txt"), "utf8"), "reachable");
});
