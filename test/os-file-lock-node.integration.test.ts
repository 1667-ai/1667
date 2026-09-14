import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isLockContention, lockFile } from "../server/os-file-lock.js";

test("Node native locks acquire and release across worker threads", async (t) => {
  if (process.versions.bun !== undefined) return t.skip("Node FFI test");
  const directory = await mkdtemp(path.join(tmpdir(), "1667-node-lock-"));
  const file = path.join(directory, "lock");
  await writeFile(file, "");
  const worker = new Worker(
    `
      import { parentPort, workerData } from "node:worker_threads";
      import { open } from "node:fs/promises";
      const { register } = await import(workerData.loader);
      register();
      const { lockFile } = await import(workerData.module);
      const handle = await open(workerData.file, "r+");
      const lock = await lockFile(handle.fd, workerData.file);
      parentPort.postMessage("locked");
      await new Promise((resolve) => parentPort.once("message", resolve));
      await lock.unlock();
      await handle.close();
      parentPort.postMessage("released");
    `,
    {
      eval: true,
      execArgv: [],
      workerData: {
        file,
        loader: import.meta.resolve("tsx/esm/api"),
        module: new URL("../server/os-file-lock.ts", import.meta.url).href
      }
    }
  );
  t.after(async () => {
    await worker.terminate();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(await nextMessage(worker), "locked");
  const contender = await open(file, "r+");
  await assert.rejects(
    lockFile(contender.fd, file),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "ELOCKED"
  );
  await contender.close();

  worker.postMessage("release");
  assert.equal(await nextMessage(worker), "released");
  const released = await open(file, "r+");
  const lock = await lockFile(released.fd, file);
  await lock.unlock();
  await released.close();
});

test("Node native locks preserve non-contention POSIX errors", async (t) => {
  if (process.versions.bun !== undefined || process.platform === "win32") {
    return t.skip("POSIX Node FFI test");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "1667-node-lock-error-"));
  const file = path.join(directory, "lock");
  await writeFile(file, "");
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    lockFile(-1, file),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "EBADF"
      && !isLockContention(error)
  );
});

function nextMessage(worker: Worker): Promise<string> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      worker.off("message", onMessage);
      reject(error);
    };
    const onMessage = (message: unknown): void => {
      worker.off("error", onError);
      resolve(String(message));
    };
    worker.once("error", onError);
    worker.once("message", onMessage);
  });
}
