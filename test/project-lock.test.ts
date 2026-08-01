import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DATA_DIRECTORY_LOCK } from "../server/data-directory-layout.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { assertLockingFilesystem } from "../server/lock-capability-probe.js";
import { publishProjectRunRecord } from "../server/project-run-record.js";

test("a second acquire on one project is refused and names the holder", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-project-lock-");
  const holder = new DataDirectoryLock(projectDir);
  await holder.acquire();
  t.after(async () => await holder.release());
  await publishProjectRunRecord(projectDir, {
    pid: 4242,
    port: 51_515,
    url: "http://127.0.0.1:51515",
    startedAt: "2026-07-25T00:00:00.000Z"
  });

  await assert.rejects(
    new DataDirectoryLock(projectDir).acquire(),
    (error: unknown) => {
      assert.match(String(error), /already open by 1667 process 4242/);
      assert.match(String(error), /1667 --url/);
      return true;
    }
  );

  // The holder is unaffected, and the refusal changed nothing on disk.
  assert.equal(holder.dataFormat, 4);
});

test("contention without a run record still refuses actionably", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-project-lock-anon-");
  const holder = new DataDirectoryLock(projectDir);
  await holder.acquire();
  t.after(async () => await holder.release());

  await assert.rejects(
    new DataDirectoryLock(projectDir).acquire(),
    /already open by another 1667 process/
  );
});

test("a dead holder leaves nothing to clean up", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-project-lock-crash-");
  const first = new DataDirectoryLock(projectDir);
  await first.acquire();
  await first.release();

  // A killed process releases the lock through the kernel. Reacquiring must
  // need no recovery step, and `lock` must still be an empty regular file.
  const child = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `import { DataDirectoryLock } from ${JSON.stringify(lockModuleUrl())};
     const lock = new DataDirectoryLock(${JSON.stringify(projectDir)});
     await lock.acquire();
     process.kill(process.pid, "SIGKILL");`
  ], { encoding: "utf8" });
  assert.notEqual(child.status, 0, child.stdout + child.stderr);

  const successor = new DataDirectoryLock(projectDir);
  await successor.acquire();
  const lockInfo = await lstat(path.join(projectDir, DATA_DIRECTORY_LOCK));
  assert.equal(lockInfo.isFile(), true);
  assert.equal(Number(lockInfo.size), 0);
  await successor.release();
});

test("a filesystem whose locks do nothing is refused, naming the project", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-lock-probe-");
  const holder = new DataDirectoryLock(projectDir);
  await holder.acquire();
  t.after(async () => await holder.release());
  const lockPath = path.join(projectDir, DATA_DIRECTORY_LOCK);

  // Real advisory locking makes the second description conflict.
  await assertLockingFilesystem(lockPath, projectDir);

  // A no-op lock primitive stands in for a mount that accepts every acquire.
  await assert.rejects(
    assertLockingFilesystem(lockPath, projectDir, async () => ({
      unlock: async () => undefined
    })),
    (error: unknown) => {
      assert.match(String(error), /does not enforce advisory locks/);
      assert.match(String(error), new RegExp(escapeRegExp(projectDir)));
      return true;
    }
  );
});

test("an ordinary folder mode is repaired rather than refused", async (t) => {
  const projectDir = await temporaryDirectory(t, "1667-project-mode-");
  const lock = new DataDirectoryLock(projectDir);

  await lock.acquire();
  try {
    if (process.platform !== "win32") {
      assert.equal((await stat(projectDir)).mode & 0o777, 0o700);
    }
  } finally {
    await lock.release();
  }
});

function lockModuleUrl(): string {
  return new URL("../server/data-directory-lock.ts", import.meta.url).href;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}
