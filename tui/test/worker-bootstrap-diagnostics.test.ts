import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import { WORKER_PROTOCOL_VERSION } from "../../shared/worker-protocol.js";
import { nextWorkerMessageOfType } from "./fixtures/real-worker.js";

test("worker retries bootstrap after machine-tier resolution fails", async () => {
  const dataDir = await mkdtemp(
    path.join(tmpdir(), "1667-worker-bootstrap-retry-")
  );
  const machineDir = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-worker-machine-"))
  );
  const dataLock = new DataDirectoryLock(dataDir);
  await dataLock.acquire();
  const worker = new Worker(
    new URL("./fixtures/machine-tier-failure-worker.ts", import.meta.url),
    { type: "module" }
  );
  try {
    await nextWorkerMessageOfType(worker, "starting");
    const firstFailure = nextWorkerMessageOfType(worker, "protocolError");
    worker.postMessage({
      type: "bootstrap",
      dataDir,
      externalDataLock: true
    });
    expect(await firstFailure).toMatchObject({
      failure: { code: "startup_failure" }
    });

    const ready = nextWorkerMessageOfType(worker, "ready");
    worker.postMessage({
      type: "bootstrap",
      dataDir,
      machineDir,
      externalDataLock: true
    });
    expect(await ready).toMatchObject({
      protocolVersion: WORKER_PROTOCOL_VERSION
    });
    const stopped = nextWorkerMessageOfType(worker, "stopped");
    worker.postMessage({ type: "shutdown" });
    await stopped;
  } finally {
    worker.terminate();
    await dataLock.release();
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(machineDir, { recursive: true, force: true })
    ]);
  }
});
