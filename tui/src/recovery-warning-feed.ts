import type { WorkerRecoveryWarning } from "./worker-api.js";

type WarningListener = (warnings: readonly WorkerRecoveryWarning[]) => void | Promise<void>;
type ErrorListener = (error: unknown) => void;

interface PendingEvent {
  warnings: readonly WorkerRecoveryWarning[];
  delivery: Promise<void> | null;
}

/** Replayable recovery delivery with explicit adoption acknowledgement. A
 * warning keeps blocking HTTP mutations until a listener reloads successfully. */
export class RecoveryWarningFeed {
  private readonly adopted = new Set<string>();
  private readonly pending: PendingEvent[] = [];
  private readonly errors: unknown[] = [];
  private readonly warningListeners = new Set<WarningListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private adoptionMutationDepth = 0;

  publish(warnings: readonly WorkerRecoveryWarning[], notifyWhenEmpty = false): boolean {
    const unresolved = warnings.filter(({ mutationId }) => !this.adopted.has(mutationId));
    const tracked = new Set(this.pending.flatMap(({ warnings: batch }) =>
      batch.map(({ mutationId }) => mutationId)));
    const fresh = unresolved.filter(({ mutationId }) => !tracked.has(mutationId));
    if (fresh.length > 0) this.pending.push({ warnings: fresh, delivery: null });
    if (warnings.length === 0 && notifyWhenEmpty) this.pending.push({ warnings: [], delivery: null });
    this.deliver();
    return unresolved.length > 0 && this.adoptionMutationDepth === 0;
  }

  /** Recovery may discover that no story survives. This narrowly admits the
   * replacement create needed to adopt that authoritative empty state. */
  async runAdoptionMutation<T>(work: () => Promise<T>): Promise<T> {
    this.adoptionMutationDepth += 1;
    try {
      return await work();
    } finally {
      this.adoptionMutationDepth -= 1;
    }
  }

  fail(error: unknown): void {
    this.errors.push(error);
    for (const listener of this.errorListeners) listener(error);
  }

  subscribe(onWarnings: WarningListener, onError: ErrorListener): () => void {
    this.warningListeners.add(onWarnings);
    this.errorListeners.add(onError);
    for (const error of this.errors) onError(error);
    this.deliver();
    return () => {
      this.warningListeners.delete(onWarnings);
      this.errorListeners.delete(onError);
    };
  }

  private deliver(): void {
    if (this.warningListeners.size === 0) return;
    for (const event of this.pending) {
      if (event.delivery !== null) continue;
      let results: Array<void | Promise<void>>;
      try {
        results = [...this.warningListeners].map((listener) => listener(event.warnings));
      } catch (error) {
        this.reportDeliveryFailure(error);
        continue;
      }
      const delivery = Promise.all(results).then(() => {
        if (event.delivery !== delivery) return;
        for (const { mutationId } of event.warnings) this.adopted.add(mutationId);
        this.pending.splice(this.pending.indexOf(event), 1);
      }, (error: unknown) => {
        if (event.delivery !== delivery) return;
        event.delivery = null;
        this.reportDeliveryFailure(error);
      });
      event.delivery = delivery;
      void delivery.catch(() => undefined);
    }
  }

  private reportDeliveryFailure(error: unknown): void {
    for (const listener of this.errorListeners) listener(error);
  }
}
