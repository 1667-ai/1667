import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  VAULT_UNSEAL_PROGRESS_DIRECTORY,
  VaultUnsealProgress
} from "../server/vault-unseal-progress.js";

test("unseal progress syncs an existing directory before it can publish witnesses", async (t) => {
  const root = await newRoot(t);
  const directory = path.join(root, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  await mkdir(directory, { mode: 0o700 });
  const calls: string[] = [];
  const syncRoot = async (value: string): Promise<void> => {
    calls.push(value);
    assert.deepEqual(await readdir(directory), []);
  };

  const loaded = await VaultUnsealProgress.load(root, randomBytes(32), { syncRoot });
  await loaded.record([path.join(root, "story.json")], Buffer.from("first witness"));

  assert.deepEqual(calls, [root]);
});

test("unseal progress syncs an EEXIST directory before it publishes a witness", async (t) => {
  const root = await newRoot(t);
  const directory = path.join(root, VAULT_UNSEAL_PROGRESS_DIRECTORY);
  const calls: string[] = [];
  const syncRoot = async (value: string): Promise<void> => {
    calls.push(value);
    assert.deepEqual(await readdir(directory), []);
  };
  const progress = await VaultUnsealProgress.load(root, randomBytes(32), { syncRoot });
  await mkdir(directory, { mode: 0o700 });

  await progress.record([path.join(root, "story.json")], Buffer.from("EEXIST witness"));

  assert.deepEqual(calls, [root]);
});

async function newRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-vault-progress-sync-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}
