import { Worker } from "node:worker_threads";

/** The small event surface shared by the host transport and Node workers. */
export interface NodeWorkerLike {
  postMessage(message: unknown): void;
  terminate(): Promise<number>;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

/**
 * Adapt Node's EventEmitter-based Worker to the event surface used by the
 * transport. The adapter owns no bootstrap policy; the transport still sends
 * the normal bootstrap message after startup.
 */
export class NodeWorkerAdapter implements NodeWorkerLike {
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly worker: Worker) {
    worker.on("message", (data: unknown) => {
      this.dispatch("message", { data } as MessageEvent<unknown>);
    });
    worker.on("error", (error: Error) => {
      this.dispatch("error", {
        error,
        message: error.message,
        preventDefault(): void {}
      });
    });
    worker.on("exit", (code: number) => {
      this.dispatch("close", { code });
    });
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }

  addEventListener(type: string, listener: EventListener): void {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set<EventListener>();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type);
    if (listeners === undefined) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.listeners.delete(type);
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as Event);
    }
  }
}

/**
 * Spawn the embedded backend in a Node worker thread. A TypeScript source
 * entry needs the same loader as the parent process; packaged Node entries
 * are already compiled JavaScript and use no source loader.
 */
export function createNodeWorker(
  entry: URL | string,
  options: { readonly source?: boolean } = {}
): NodeWorkerLike {
  const worker = new Worker(entry, {
    // Node 22 needs explicit registration inside the worker thread.
    ...(options.source === true ? {
      execArgv: ["--import", "data:text/javascript," + encodeURIComponent(
        `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register();`
      )]
    } : {})
  });
  return new NodeWorkerAdapter(worker);
}
