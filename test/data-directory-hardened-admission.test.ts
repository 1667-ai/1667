import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DATA_DIRECTORY_HARDENED_PROCESS_LOCK,
  DATA_DIRECTORY_OWNER_MARKER,
  SETTINGS_STATE_V2_FILE
} from "../server/data-directory-layout.js";
import {
  assertHardenedDataDirectoryPlatform
} from "../server/data-directory-admission.js";
import { ServiceError } from "../server/errors.js";
import { RuntimeDataDirectoryLock } from "../server/runtime-data-directory.js";

test("hardened data admission fails closed without a Windows ACL adapter", () => {
  assert.throws(
    () => assertHardenedDataDirectoryPlatform("win32"),
    (error: unknown) => error instanceof ServiceError
      && error.status === 501
      && error.code === "data_directory_unowned"
  );
});

test("hardened runtime publishes only an explicitly authorized absent target", async (t) => {
  const parent = await mkdtemp(path.join(homedir(), ".1667-hard-init-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "default");

  await assert.rejects(
    new RuntimeDataDirectoryLock(target, { hardened: true }).acquire(),
    (error: unknown) => error instanceof ServiceError
      && error.code === "data_directory_unowned"
  );
  await assert.rejects(access(target));

  const owner = new RuntimeDataDirectoryLock(target, {
    hardened: true,
    initializeNew: true,
    offlineExclusive: true
  });
  t.after(() => owner.release());
  await owner.acquire();
  assert.equal((await stat(target)).isDirectory(), true);
  await access(path.join(target, DATA_DIRECTORY_OWNER_MARKER));
  await access(path.join(target, SETTINGS_STATE_V2_FILE));
  await access(path.join(target, DATA_DIRECTORY_HARDENED_PROCESS_LOCK));
  const digest = createHash("sha256").update("default", "utf8").digest("hex");
  const transaction = path.join(parent, `.1667-init-${digest}`);
  assert.deepEqual(await readdir(transaction), [".1667-init.lock"]);

  await assert.rejects(
    new RuntimeDataDirectoryLock(target, { hardened: true }).acquire(),
    (error: unknown) => error instanceof ServiceError && error.status === 409
  );
  await assert.rejects(bindGuard(), /EADDRINUSE/);
  await owner.release();

  const successor = new RuntimeDataDirectoryLock(target, { hardened: true });
  await successor.acquire();
  await successor.release();
});

test("hardened runtime refuses an existing empty target without mutation", async (t) => {
  const parent = await mkdtemp(path.join(homedir(), ".1667-hard-empty-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "default");
  await mkdir(target);
  if (process.platform !== "win32") await chmod(target, 0o755);

  await assert.rejects(
    new RuntimeDataDirectoryLock(target, {
      hardened: true,
      initializeNew: true,
      offlineExclusive: true
    }).acquire(),
    (error: unknown) => error instanceof ServiceError
      && error.code === "data_directory_unowned"
  );
  assert.deepEqual(await readdir(target), []);
  if (process.platform !== "win32") {
    assert.equal((await stat(target)).mode & 0o777, 0o755);
  }
  assert.deepEqual(
    (await readdir(parent)).filter((entry) =>
      entry.startsWith(".1667-init-")),
    []
  );
});

test("hardened initialization rejects writable shared ancestors", {
  skip: process.platform === "win32"
}, async (t) => {
  const sharedRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const shared = await mkdtemp(path.join(sharedRoot, "1667-hard-shared-"));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const target = path.join(shared, "default");
  await assert.rejects(
    new RuntimeDataDirectoryLock(target, {
      hardened: true,
      initializeNew: true,
      offlineExclusive: true
    }).acquire(),
    /ancestor grants untrusted rename\/create authority/
  );
  await assert.rejects(access(target));
});

async function bindGuard(): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { host: "127.0.0.1", port: 7373, exclusive: true },
      () => server.close((error) => error === undefined ? resolve() : reject(error))
    );
  });
}
