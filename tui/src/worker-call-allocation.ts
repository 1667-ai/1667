import type { WorkerMethod } from "../../shared/worker-protocol.js";
import type { WorkerLike } from "./worker-lifecycle.js";
import {
  type PendingRequestRegistry,
  type RegisteredCall
} from "./worker-pending.js";
import type { SerializedWorkerOutbox } from "./worker-outbox.js";
import { cancelPendingWorkerRequest } from "./worker-user-cancellation.js";

interface OpenPendingWorkerCallOptions {
  method: WorkerMethod;
  stream: boolean;
  mutationId?: string;
  durableIntent?: boolean;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs: number | null;
  deadlineAfterMs: number;
  cancelGraceMs: number;
  pendingRequests: PendingRequestRegistry;
  worker: WorkerLike;
  outbox: SerializedWorkerOutbox;
  fail(error: Error): void;
  failForRestart(message: string, cause?: unknown): void;
  allocationFailure(error: unknown): never;
}

/** Allocates one incarnation-bound call and owns its abort/deadline timers. */
export function openPendingWorkerCall<T>(
  options: OpenPendingWorkerCallOptions
): RegisteredCall<T> {
  try {
    return options.pendingRequests.open<T>({
      method: options.method,
      replay: false,
      stream: options.stream,
      ...(options.mutationId === undefined ? {} : { mutationId: options.mutationId }),
      ...(options.durableIntent === undefined ? {} : { durableIntent: options.durableIntent }),
      ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs ?? options.deadlineAfterMs,
      onAbort: (id) => cancelPendingWorkerRequest({
        id,
        pendingRequests: options.pendingRequests,
        worker: options.worker,
        outbox: options.outbox,
        graceMs: options.cancelGraceMs,
        fail: options.failForRestart
      }),
      onTimeout: (id) => {
        const pending = options.pendingRequests.get(id);
        if (pending === undefined) return;
        try {
          options.worker.postMessage({ type: "cancel", id, reason: "deadline" });
        } catch (error) {
          options.fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        pending.startCancellationGrace(options.cancelGraceMs, () => {
          if (!options.pendingRequests.isCurrent(pending)) return;
          options.failForRestart(
            options.timeoutMs === null
              ? `Embedded backend ${options.method} exceeded its ${options.deadlineAfterMs} ms recovery deadline and ${options.cancelGraceMs} ms cancellation grace`
              : `Embedded backend ${options.method} exceeded its ${options.timeoutMs} ms deadline and ${options.cancelGraceMs} ms cancellation grace`
          );
        });
      }
    });
  } catch (error) {
    return options.allocationFailure(error);
  }
}
