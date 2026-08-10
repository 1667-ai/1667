/** Fixed-capacity, recency-ordered cache. `Map` iteration order tracks
 * recency directly: both `get` and `set` move the touched entry to the
 * most-recently-used end (delete then re-insert), and `set` evicts from the
 * least-recently-used end — the first key `Map` yields — once capacity is
 * exceeded. Callers that treat a miss as "go recompute it" can use this to
 * bound an unbounded cache without changing its correctness, only its hit
 * rate. */
export class BoundedLruMap<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("Bounded LRU capacity must be a positive safe integer");
    }
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
