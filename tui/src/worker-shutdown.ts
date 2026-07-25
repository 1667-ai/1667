import type { WorkerLike } from "./worker-lifecycle.js";
import type { SerializedWorkerOutbox } from "./worker-outbox.js";
import type { PendingRequestRegistry } from "./worker-pending.js";

/** Make foreground cancellations durable and detach replays before worker
 * shutdown aborts can produce terminal-looking stream completions. */
export async function preparePendingWorkerShutdown(
  pendingRequests: PendingRequestRegistry,
  outbox: SerializedWorkerOutbox,
  worker: WorkerLike,
  graceMs: number,
  hardFence: (message: string, cause?: unknown) => Error
): Promise<void> {
  const ids = [...pendingRequests.ids()];
  const store = outbox.store;
  if (store !== null) {
    const cancellations = ids.flatMap((id) => {
      const pending = pendingRequests.get(id);
      const mutationId = pending?.mutationId;
      return mutationId === undefined || pending?.replay !== false || pending.settling
        ? []
        : [outbox.runIndependent(async () => {
          if (!pendingRequests.isCurrent(pending) || pending.settling) return;
          await store.cancel(mutationId);
        })];
    });
    await boundShutdownCancellation(cancellations, graceMs, hardFence);
  }
  for (const id of ids) {
    const pending = pendingRequests.get(id);
    if (pending === undefined || pending.settling) continue;
    if (pending.replay) {
      pendingRequests.reject(id, new Error("Embedded backend stopped during mutation recovery"));
      continue;
    }
    try {
      worker.postMessage({ type: "cancel", id, reason: "shutdown" });
    } catch {
      // Termination is the authoritative cancellation boundary.
    }
  }
}

async function boundShutdownCancellation(
  cancellations: Promise<void>[],
  graceMs: number,
  hardFence: (message: string, cause?: unknown) => Error
): Promise<void> {
  if (cancellations.length === 0) return;
  const persisted = Promise.all(cancellations).catch((error: unknown) => {
    throw hardFence(
      "Embedded backend shutdown cancellation could not be durably recorded",
      error
    );
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(hardFence(
      `Embedded backend shutdown cancellation was not durably recorded within ${graceMs} ms`
    )), graceMs);
  });
  try {
    await Promise.race([persisted, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
