import {
  isWorkerMutationMethod,
  type WorkerOperationId
} from "../../shared/worker-protocol.js";
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

/** Durably records caller cancellation, delivers it, then, for a mutation,
 * requires terminal worker evidence within a fixed grace period. A
 * non-mutating call is read-only advisory: once delivery succeeds, the local
 * call retires immediately, and any worker delta or terminal that arrives
 * for it afterward lands on an unknown ID, which the transport already
 * acknowledges harmlessly. */
export function cancelPendingWorkerRequest(
  options: WorkerUserCancellationOptions
): void {
  const pending = options.pendingRequests.get(options.id);
  if (pending === undefined) return;
  const mutationId = pending.mutationId;
  const store = options.outbox.store;
  // Without a durable intent (local durability tier) there is nothing for a
  // replacement process to replay, so cancellation needs no durable marker.
  if (mutationId === undefined || store === null || !pending.durableIntent) {
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
  if (!isWorkerMutationMethod(pending.method)) {
    retireDeliveredCancellation(options, pending);
    return;
  }
  armGrace(options, pending, "did not reach terminal state");
}

/** A non-mutating call has nothing to fence: there is no durable intent to
 * protect and no story mutation whose outcome could go uncertain. Retiring
 * it here, rather than waiting on a terminal that may never come, keeps a
 * stalled read from taking down the transport or blocking a concurrent
 * mutation. */
function retireDeliveredCancellation(
  options: WorkerUserCancellationOptions,
  pending: PendingCall
): void {
  options.pendingRequests.discard(pending.id);
  pending.resolve(null);
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
