/** Process-local FIFO serialization with automatic key eviction. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(key, settled);
    try {
      return await result;
    } finally {
      void settled.then(() => {
        if (this.tails.get(key) === settled) this.tails.delete(key);
      });
    }
  }
}
