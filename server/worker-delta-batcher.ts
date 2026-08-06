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
  /** A deadline dispose transfers every later `send` handoff into `sealed`.
   *  A normal dispose drops those handoffs. */
  private sealAfterDispose = false;
  /** The one batch currently past `DeltaBatcher` and waiting on
   *  `waitForCredit`, if any. A batch is always in exactly one place: in
   *  `DeltaBatcher`'s `chunks`, or here in `inFlight`. `DeltaBatcher` drains
   *  a batch out of `chunks` inside its send queue, at the same step that
   *  calls `send`, so no window exists between the two places.
   *  `takeUnsent` reclaims the in-flight batch by clearing this field;
   *  `send` checks the field is still its own text before it posts, so a
   *  reclaimed batch can never reach `post`. */
  private inFlight: string | null = null;
  /** Tail reclaimed by `sealUnsent` and held for `takeUnsent`. A deadline
   *  cancel reclaims at receipt (to release parked producers immediately)
   *  while its error terminal is published later by the request executor. */
  private sealed = "";

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
    const text = this.sealed + (this.inFlight ?? "") + this.batcher.takeBuffered();
    this.sealed = "";
    this.inFlight = null;
    return text;
  }

  /** Reclaim every accepted-but-unsent batch now, retain it for a later
   *  `takeUnsent`, and dispose. The deadline cancel path uses this: parked
   *  producers must unblock at cancel receipt, but the tail belongs to the
   *  error terminal the executor publishes afterwards. */
  sealUnsent(): void {
    if (this.disposed) return;
    const tail = this.sealed + (this.inFlight ?? "") + this.batcher.takeBuffered();
    this.inFlight = null;
    this.sealAfterDispose = true;
    this.stopTransport();
    this.sealed = tail;
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
    this.sealAfterDispose = false;
    this.inFlight = null;
    this.sealed = "";
    this.stopTransport();
  }

  private stopTransport(): void {
    this.disposed = true;
    this.batcher.dispose();
    this.unacknowledged.clear();
    this.unacknowledgedBytes = 0;
    this.releaseCreditWaiters();
  }

  private async send(text: string, bytes: number): Promise<void> {
    // An oversized push can still own later split chunks after sealUnsent()
    // releases its first credit-blocked chunk. They were accepted by push()
    // before the deadline, so append each later handoff in source order.
    if (this.disposed) {
      if (this.sealAfterDispose) this.sealed += text;
      return;
    }
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
