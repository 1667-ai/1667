import {
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  MAX_UNACKNOWLEDGED_DELTA_BYTES,
  type WorkerOperationId,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { DeltaBatcher } from "./delta-batcher.js";

type DeltaMessage = Extract<WorkerToMainMessage, { type: "delta" }>;

/** Batches generation output over `DeltaBatcher` (the same batching policy
 *  the HTTP path uses, `server/stream-response.ts`) and stops its producer
 *  at a bounded credit window: this class's own contribution is the
 *  postMessage-specific backpressure gate and sequence numbering, not the
 *  batching timing itself. */
export class WorkerDeltaBatcher {
  private readonly batcher: DeltaBatcher;
  private sequence = 0;
  private readonly unacknowledged = new Map<number, number>();
  private unacknowledgedBytes = 0;
  private readonly creditWaiters = new Set<() => void>();
  private disposed = false;
  /** The one batch currently past `DeltaBatcher` and waiting on
   *  `waitForCredit`, if any. `DeltaBatcher`'s `sendQueue` admits only one
   *  delivery at a time, so one slot is always enough. `takeUnsent` reclaims
   *  it by clearing this field; `send` checks the field is still its own
   *  text before it posts, so a reclaimed batch can never reach `post`. */
  private inFlight: string | null = null;

  constructor(
    private readonly id: WorkerOperationId,
    private readonly post: (message: DeltaMessage) => void
  ) {
    this.batcher = new DeltaBatcher(
      (text, bytes) => this.send(text, bytes)
    );
  }

  async push(text: string): Promise<void> {
    await this.batcher.push(text);
  }

  async flush(): Promise<void> {
    await this.batcher.flush();
  }

  /** Remove all accepted text that has not entered the main-thread queue:
   *  the batch currently waiting on transport credit (if any), followed by
   *  whatever is still buffered behind it. The in-flight batch is always
   *  the earliest unconsumed text, so this order matches acceptance order. */
  takeUnsent(): string {
    const text = (this.inFlight ?? "") + this.batcher.takeBuffered();
    this.inFlight = null;
    return text;
  }

  acknowledge(sequence: number): void {
    for (const [candidate, bytes] of this.unacknowledged) {
      if (candidate > sequence) break;
      this.unacknowledged.delete(candidate);
      this.unacknowledgedBytes -= bytes;
    }
    this.releaseCreditWaiters();
  }

  dispose(): void {
    this.disposed = true;
    this.inFlight = null;
    this.batcher.dispose();
    this.unacknowledged.clear();
    this.unacknowledgedBytes = 0;
    this.releaseCreditWaiters();
  }

  private async send(text: string, bytes: number): Promise<void> {
    this.inFlight = text;
    await this.waitForCredit(bytes);
    // Reclaimed by takeUnsent(), or disposed, while this waited: never post.
    if (this.disposed || this.inFlight !== text) return;
    this.inFlight = null;
    const sequence = this.sequence++;
    this.unacknowledged.set(sequence, bytes);
    this.unacknowledgedBytes += bytes;
    this.post({ type: "delta", id: this.id, sequence, text });
  }

  private async waitForCredit(bytes: number): Promise<void> {
    while (!this.disposed && (
      this.unacknowledged.size >= MAX_UNACKNOWLEDGED_DELTA_BATCHES
      || this.unacknowledgedBytes + bytes > MAX_UNACKNOWLEDGED_DELTA_BYTES
    )) {
      await new Promise<void>((resolve) => this.creditWaiters.add(resolve));
    }
  }

  private releaseCreditWaiters(): void {
    for (const resolve of this.creditWaiters) resolve();
    this.creditWaiters.clear();
  }
}
