import { ServiceError } from "./errors.js";

/** Admission gate plus observable drain for HTTP requests during shutdown. */
export class RequestDrain {
  private readonly active = new Set<Promise<unknown>>();
  private accepting = true;

  run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new ServiceError(503, "Story service is shutting down"));
    const operation = Promise.resolve().then(work);
    let tracked!: Promise<T>;
    tracked = operation.finally(() => this.active.delete(tracked));
    this.active.add(tracked);
    return tracked;
  }

  beginShutdown(): void {
    this.accepting = false;
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active]);
  }
}
