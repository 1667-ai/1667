import type { WorkerOperationId } from "../../shared/worker-protocol.js";
import type { WorkerLike } from "./worker-lifecycle.js";
import type { PendingCall, PendingRequestRegistry } from "./worker-pending.js";
import type { SerializedWorkerOutbox } from "./worker-outbox.js";

interface WorkerUserCancellationOptions {
  id: WorkerOperationId;
  pendingRequests: PendingRequestRegistry;
  worker: WorkerLike;
  outbox: SerializedWorkerOutbox;
  graceMs: number;
  fail(message: string, cause?: unknown): void;
}

/** Durably records caller cancellation, delivers it, then requires terminal
 * worker evidence. Either phase is bounded by the same fixed grace period. */
export function cancelPendingWorkerRequest(
  options: WorkerUserCancellationOptions
): void {
  const pending = options.pendingRequests.get(options.id);
  if (pending === undefined) return;
  const mutationId = pending.mutationId;
  const store = options.outbox.store;
  if (mutationId === undefined || store === null) {
    deliverCancellation(options, pending);
    return;
  }

  const persistenceTimer = setTimeout(() => {
    if (!options.pendingRequests.isCurrent(pending)) return;
    options.fail(
      `Embedded backend ${pending.method} cancellation was not durably recorded within ${options.graceMs} ms`
    );
  }, options.graceMs);
  void options.outbox.runIndependent(() => store.cancel(mutationId)).then(
    () => {
      clearTimeout(persistenceTimer);
      deliverCancellation(options, pending);
    },
    (error: unknown) => {
      clearTimeout(persistenceTimer);
      if (!canDeliverCancellation(options, pending)) return;
      options.fail(
        `Embedded backend ${pending.method} cancellation could not be durably recorded`,
        error
      );
    }
  );
}

function deliverCancellation(
  options: WorkerUserCancellationOptions,
  pending: PendingCall
): void {
  if (!canDeliverCancellation(options, pending)) return;
  try {
    options.worker.postMessage({
      type: "cancel",
      id: pending.id,
      reason: "user"
    });
  } catch (error) {
    options.fail(
      `Embedded backend ${pending.method} cancellation could not be sent`,
      error
    );
    return;
  }
  armGrace(options, pending, "did not reach terminal state");
}

function armGrace(
  options: WorkerUserCancellationOptions,
  pending: PendingCall,
  outcome: string
): void {
  pending.startCancellationGrace(options.graceMs, () => {
    if (!canDeliverCancellation(options, pending)) return;
    options.fail(
      `Embedded backend ${pending.method} cancellation ${outcome} within ${options.graceMs} ms`
    );
  });
}

function canDeliverCancellation(
  options: WorkerUserCancellationOptions,
  pending: PendingCall
): boolean {
  return options.pendingRequests.isCurrent(pending) && !pending.settling;
}
