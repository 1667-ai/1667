import {
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  MAX_UNACKNOWLEDGED_DELTA_BYTES,
  type WorkerOperationId,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";
import { DeltaBatcher, splitUtf8 } from "./delta-batcher.js";

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
  /** Every accepted `push` that can still append split chunks to `sealed`.
   *  Terminal publication waits for these producers, so a single provider
   *  delta that spans several batches cannot lose its later chunks. */
  private readonly pendingPushes = new Set<Promise<void>>();
  private disposed = false;
  /** A sealed transport transfers every later `send` handoff into `sealed`.
   *  A normal dispose drops those handoffs. */
  private sealAfterDispose = false;
  /** The one batch currently past `DeltaBatcher` and waiting on
   *  `waitForCredit`, if any. A batch is always in exactly one place: in
   *  `DeltaBatcher`'s `chunks`, or here in `inFlight`. `DeltaBatcher` drains
   *  a batch out of `chunks` inside its send queue, at the same step that
   *  calls `send`, so no window exists between the two places.
   *  `sealUnsent` reclaims the in-flight batch by clearing this field; the
   *  terminal path republishes it only through `publishSealed`. */
  private inFlight: string | null = null;
  /** Tail reclaimed by `sealUnsent`. Terminal settlement publishes this text
   *  as bounded sequenced deltas after the producer finishes. */
  private sealed = "";

  constructor(
    private readonly id: WorkerOperationId,
    private readonly post: (message: DeltaMessage) => void
  ) {
    this.batcher = new DeltaBatcher(
      (text, bytes) => this.send(text, bytes)
    );
  }

  push(text: string): Promise<void> {
    const pending = this.batcher.push(text);
    this.pendingPushes.add(pending);
    void pending.then(
      () => this.pendingPushes.delete(pending),
      () => this.pendingPushes.delete(pending)
    );
    return pending;
  }

  async flush(): Promise<void> {
    await this.batcher.flush();
  }

  /** Reclaim every accepted-but-unsent batch now, retain it for a later
   *  bounded delta publication, and dispose the credit-gated transport.
   *  Cancellation uses this at receipt so parked producers unblock at once. */
  sealUnsent(): void {
    if (this.disposed) return;
    const tail = this.sealed + (this.inFlight ?? "") + this.batcher.takeBuffered();
    this.inFlight = null;
    this.sealAfterDispose = true;
    this.stopTransport();
    this.sealed = tail;
  }

  /** Publish a sealed tail after its producer has completed. These terminal
   *  deltas retain normal sequence numbers and batch bounds, but bypass
   *  credit because the terminal must not wait for acknowledgements. */
  async publishSealed(): Promise<void> {
    if (!this.sealAfterDispose) return;
    await this.waitForAcceptedPushes();
    await this.batcher.flush();
    const tail = this.sealed;
    this.sealed = "";
    for (const text of splitUtf8(tail, MAX_DELTA_BATCH_BYTES)) {
      this.post({ type: "delta", id: this.id, sequence: this.sequence++, text });
    }
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
    // Sealed or disposed while this waited: never use the credit-gated post.
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

  private async waitForAcceptedPushes(): Promise<void> {
    while (this.pendingPushes.size > 0) {
      await Promise.all(this.pendingPushes);
    }
  }
}
