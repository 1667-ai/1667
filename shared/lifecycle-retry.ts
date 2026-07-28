interface LifecycleRetryOptions {
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
}

interface RetryEntry<Key> {
  readonly key: Key;
  readonly work: () => Promise<void>;
  readonly onFirstFailure: (error: unknown) => void | Promise<void>;
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
}

/** Retries keyed maintenance until it succeeds or its owner stops. */
export class LifecycleRetry<Key> {
  private readonly entries = new Map<Key, RetryEntry<Key>>();
  private readonly initialDelayMs: number;
  private readonly maximumDelayMs: number;
  private stopped = false;

  constructor(options: LifecycleRetryOptions = {}) {
    this.initialDelayMs = options.initialDelayMs ?? 50;
    this.maximumDelayMs = options.maximumDelayMs ?? 5_000;
  }

  async start(
    key: Key,
    work: () => Promise<void>,
    onFirstFailure: (error: unknown) => void | Promise<void> =
      () => undefined
  ): Promise<void> {
    if (this.stopped || this.entries.has(key)) return;
    const entry: RetryEntry<Key> = {
      key,
      work,
      onFirstFailure,
      failures: 0,
      timer: null,
      running: null
    };
    this.entries.set(key, entry);
    await this.attempt(entry);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
    }
    await Promise.allSettled(
      [...this.entries.values()]
        .map(({ running }) => running)
        .filter((running): running is Promise<void> => running !== null)
    );
    this.entries.clear();
  }

  private async attempt(entry: RetryEntry<Key>): Promise<void> {
    if (this.stopped || this.entries.get(entry.key) !== entry) return;
    const running = this.runAttempt(entry);
    entry.running = running;
    try {
      await running;
    } finally {
      if (entry.running === running) entry.running = null;
    }
  }

  private async runAttempt(entry: RetryEntry<Key>): Promise<void> {
    try {
      await entry.work();
      if (this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key);
      }
    } catch (error) {
      if (entry.failures === 0) {
        try {
          await entry.onFirstFailure(error);
        } catch {
          // Maintenance retry must survive diagnostic failure.
        }
      }
      entry.failures += 1;
      if (this.stopped || this.entries.get(entry.key) !== entry) {
        this.entries.delete(entry.key);
        return;
      }
      const delayMs = Math.min(
        this.initialDelayMs * 2 ** Math.min(entry.failures - 1, 16),
        this.maximumDelayMs
      );
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void this.attempt(entry);
      }, delayMs);
      unrefTimer(entry.timer);
    }
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object"
    && timer !== null
    && "unref" in timer
    && typeof timer.unref === "function") {
    timer.unref();
  }
}
