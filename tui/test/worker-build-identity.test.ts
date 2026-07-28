import { expect, test } from "bun:test";
import { createSourceBuildIdentity } from "../../shared/build-identity.js";
import {
  PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION,
  WORKER_PROTOCOL_VERSION
} from "../../shared/worker-protocol.js";
import { createWorkerStoryApi } from "../src/worker-api.js";

test("embedded transport rejects a worker built from different application bytes", async () => {
  const worker = new MismatchedIdentityWorker();
  let error: unknown;
  try {
    await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
  } catch (caught) {
    error = caught;
  }

  expect(error instanceof Error).toBeTrue();
  expect((error as Error).message).toContain("build mismatch");
  expect(worker.terminateCalls).toBe(1);
});

test("embedded transport rejects the pre-recovery worker protocol", async () => {
  const worker = new PreRecoveryWorker();
  let error: unknown;
  try {
    await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
  } catch (caught) {
    error = caught;
  }

  expect(error instanceof Error).toBeTrue();
  expect((error as Error).message).toContain("build mismatch");
  expect(worker.terminateCalls).toBe(1);
});

class MismatchedIdentityWorker extends EventTarget {
  terminateCalls = 0;

  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
      type: "ready",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      buildIdentity: createSourceBuildIdentity("0.1.1"),
      workerInstanceId: "1".repeat(32)
    } })));
  }

  postMessage(): void {}

  terminate(): void {
    this.terminateCalls += 1;
    this.dispatchEvent(new Event("close"));
  }
}

class PreRecoveryWorker extends EventTarget {
  terminateCalls = 0;

  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: {
        type: "ready",
        protocolVersion: PRE_PROVIDER_RECOVERY_WORKER_PROTOCOL_VERSION,
        buildIdentity: createSourceBuildIdentity(),
        workerInstanceId: "2".repeat(32)
      }
    })));
  }

  postMessage(): void {}

  terminate(): void {
    this.terminateCalls += 1;
    this.dispatchEvent(new Event("close"));
  }
}
