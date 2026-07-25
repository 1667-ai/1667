import type { MutationOutbox } from "../../server/mutation-outbox.js";

/** Serializes durable outbox transitions and makes shutdown wait for every
 * operation, including work queued by abort and terminal-message callbacks. */
export class SerializedWorkerOutbox {
  private readonly operations = new Set<Promise<unknown>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly store: MutationOutbox | null) {}

  /** Keeps shutdown behind a multi-step transition even between its serialized
   * store operations. The returned release is idempotent. */
  retain(): () => void {
    let releaseOperation!: () => void;
    const operation = new Promise<void>((resolve) => { releaseOperation = resolve; });
    let retained = true;
    this.operations.add(operation);
    return () => {
      if (!retained) return;
      retained = false;
      this.operations.delete(operation);
      releaseOperation();
    };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work, work);
    this.queue = operation.then(() => undefined, () => undefined);
    return await this.track(operation);
  }

  /** Cancellation markers must not wait behind the publication they fence,
   * while shutdown must still own their settlement. */
  async runIndependent<T>(work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work);
    this.queue = Promise.allSettled([this.queue, operation]).then(() => undefined);
    return await this.track(operation);
  }

  private async track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    try {
      return await operation;
    } finally {
      this.operations.delete(operation);
    }
  }

  async drain(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations]);
    }
  }
}
