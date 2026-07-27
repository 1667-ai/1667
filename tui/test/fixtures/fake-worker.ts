import {
  platformPerformanceBudget
} from "../../../test/platform-performance-budget.js";
import {
  WORKER_BUILD_IDENTITY,
  WORKER_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerMethod,
  type WorkerToMainMessage
} from "../../../shared/worker-protocol.js";

export const TEST_WORKER_INSTANCE_ID = "1".repeat(32);

export class FakeWorker extends EventTarget {
  readonly messages: MainToWorkerMessage[] = [];
  terminateCalls = 0;

  constructor(private readonly stopOnShutdown = false) {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
      type: "ready",
      protocolVersion: WORKER_PROTOCOL_VERSION,
      buildIdentity: WORKER_BUILD_IDENTITY,
      workerInstanceId: TEST_WORKER_INSTANCE_ID
    } })));
  }

  postMessage(message: MainToWorkerMessage): void {
    this.messages.push(message);
    if (message.type === "shutdown" && this.stopOnShutdown) {
      this.dispatchEvent(new MessageEvent("message", { data: { type: "stopped" } }));
    }
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.dispatchEvent(new Event("close"));
  }

  crash(message: string): void {
    this.dispatchEvent(new ErrorEvent("error", { message }));
  }

  message(message: WorkerToMainMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

export async function waitForRequest(
  worker: FakeWorker,
  method: WorkerMethod,
  timeoutMs = platformPerformanceBudget(1_000)
): Promise<Extract<MainToWorkerMessage, { type: "request" }>> {
  const deadline = Date.now() + timeoutMs;
  do {
    const request = worker.messages.findLast((message) =>
      message.type === "request" && message.method === method
    );
    if (request?.type === "request") return request;
    await new Promise((resolve) => setTimeout(resolve, 1));
  } while (Date.now() < deadline);
  throw new Error(`${method} request was not sent`);
}
