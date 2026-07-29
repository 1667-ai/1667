import {
  DELTA_BATCH_WINDOW_MS,
  MAX_DELTA_BATCH_BYTES,
  MAX_UNACKNOWLEDGED_DELTA_BATCHES,
  MAX_UNACKNOWLEDGED_DELTA_BYTES,
  type WorkerOperationId,
  type WorkerToMainMessage
} from "../shared/worker-protocol.js";

type DeltaMessage = Extract<WorkerToMainMessage, { type: "delta" }>;

/** Batches generation output and stops its producer at a bounded credit window. */
export class WorkerDeltaBatcher {
  private chunks: string[] = [];
  private bytes = 0;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unacknowledged = new Map<number, number>();
  private unacknowledgedBytes = 0;
  private creditWaiters = new Set<() => void>();
  private sendQueue = Promise.resolve();
  private timedFlush: Promise<void> | null = null;
  private unsentText = "";
  private disposed = false;

  constructor(
    private readonly id: WorkerOperationId,
    private readonly post: (message: DeltaMessage) => void
  ) {}

  async push(text: string): Promise<void> {
    for (const chunk of splitUtf8(text, MAX_DELTA_BATCH_BYTES)) {
      await this.waitForTimedFlush();
      if (this.disposed) return;
      const bytes = byteLength(chunk);
      if (this.bytes > 0 && this.bytes + bytes > MAX_DELTA_BATCH_BYTES) await this.flush();
      this.chunks.push(chunk);
      this.bytes += bytes;
      this.unsentText += chunk;
      if (this.bytes >= MAX_DELTA_BATCH_BYTES) await this.flush();
      else if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          const flushing = this.flushBuffered();
          this.timedFlush = flushing;
          void flushing.finally(() => {
            if (this.timedFlush === flushing) this.timedFlush = null;
          });
        }, DELTA_BATCH_WINDOW_MS);
      }
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.waitForTimedFlush();
    await this.flushBuffered();
    await this.sendQueue;
  }

  /** Remove all accepted text that has not entered the main-thread queue. */
  takeUnsent(): string {
    if (this.disposed || this.unsentText.length === 0) return "";
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const text = this.unsentText;
    this.unsentText = "";
    this.chunks = [];
    this.bytes = 0;
    return text;
  }

  private async flushBuffered(): Promise<void> {
    if (this.chunks.length === 0 || this.disposed) return;
    const text = this.chunks.join("");
    const bytes = this.bytes;
    this.chunks = [];
    this.bytes = 0;
    const send = this.sendQueue.then(() => this.send(text, bytes));
    this.sendQueue = send.catch(() => undefined);
    await send;
  }

  private async waitForTimedFlush(): Promise<void> {
    if (this.timedFlush !== null) await this.timedFlush;
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
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.chunks = [];
    this.bytes = 0;
    this.unsentText = "";
    this.unacknowledged.clear();
    this.unacknowledgedBytes = 0;
    this.releaseCreditWaiters();
  }

  private async send(text: string, bytes: number): Promise<void> {
    await this.waitForCredit(bytes);
    if (this.disposed) return;
    if (!this.unsentText.startsWith(text)) {
      throw new Error("Worker delta queue lost its accepted-text prefix");
    }
    this.unsentText = this.unsentText.slice(text.length);
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [];
  if (byteLength(value) <= maxBytes) return [value];
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (bytes + characterBytes > maxBytes && chunk.length > 0) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}
