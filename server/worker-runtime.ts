/**
 * Map the runtime's worker messaging API to the three operations used by
 * `server/worker.ts`.
 *
 * Bun exposes the Web Worker globals that the existing worker uses. Node
 * exposes `parentPort` instead. Keep the Node import behind a runtime guard so
 * the Bun standalone build never tries to load a Node-only module.
 */
export interface WorkerRuntime {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  close(): void;
}

export async function createWorkerRuntime(): Promise<WorkerRuntime> {
  if (isNodeWorkerRuntime()) return await createNodeWorkerRuntime();
  return createGlobalWorkerRuntime();
}

function isNodeWorkerRuntime(): boolean {
  return typeof process !== "undefined"
    && process.versions?.node !== undefined
    && process.versions?.bun === undefined;
}

async function createNodeWorkerRuntime(): Promise<WorkerRuntime> {
  const { parentPort } = await import("node:worker_threads");
  if (parentPort === null) {
    throw new Error("Embedded backend worker has no parent port");
  }
  let onmessage: WorkerRuntime["onmessage"] = null;
  parentPort.on("message", (data: unknown) => {
    onmessage?.({ data } as MessageEvent<unknown>);
  });
  return {
    postMessage(message: unknown): void {
      parentPort.postMessage(message);
    },
    get onmessage(): WorkerRuntime["onmessage"] {
      return onmessage;
    },
    set onmessage(handler: WorkerRuntime["onmessage"]) {
      onmessage = handler;
    },
    close(): void {
      parentPort.close();
    }
  };
}

function createGlobalWorkerRuntime(): WorkerRuntime {
  const runtime = globalThis as unknown as Partial<WorkerRuntime>;
  if (typeof runtime.postMessage !== "function") {
    throw new Error("Embedded backend worker has no supported runtime");
  }
  return {
    postMessage(message: unknown): void {
      runtime.postMessage?.(message);
    },
    get onmessage(): WorkerRuntime["onmessage"] {
      return runtime.onmessage ?? null;
    },
    set onmessage(handler: WorkerRuntime["onmessage"]) {
      runtime.onmessage = handler;
    },
    close(): void {
      runtime.close?.();
    }
  };
}
