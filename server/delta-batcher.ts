import {
  DELTA_BATCH_WINDOW_MS,
  MAX_DELTA_BATCH_BYTES
} from "../shared/worker-protocol.js";

/**
 * Accumulates delta text and flushes it as bounded batches, at a byte
 * threshold or a time window, whichever comes first — the batching policy
 * the embedded worker path established (`shared/worker-protocol.ts`'s
 * `MAX_DELTA_BATCH_BYTES` / `DELTA_BATCH_WINDOW_MS`).
 *
 * `send` performs the actual delivery for one flushed batch, and decides its
 * own readiness gate: a worker credit wait before it posts, a plain
 * `await` of an HTTP write's drain event, or nothing at all. This class only
 * decides *when* to flush; it does not know or care *how* a batch leaves the
 * process. `WorkerDeltaBatcher` (`server/worker-delta-batcher.ts`) and the
 * HTTP path (`server/stream-response.ts`) each supply their own `send` over
 * one shared instance of this class, so the batching policy itself never
 * forks into two implementations.
 */
export class DeltaBatcher {
  private chunks: string[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sendQueue = Promise.resolve();
  private timedFlush: Promise<void> | null = null;
  private unsentText = "";
  private disposed = false;

  constructor(
    private readonly send: (text: string, bytes: number) => Promise<void>
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

  /** Force out whatever is buffered now, bypassing the time window, and wait
   *  for every batch already handed to `send` to finish. Callers use this to
   *  guarantee a pending batch reaches `send` before a terminal event that
   *  must not be delayed behind it or reordered around it. */
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.waitForTimedFlush();
    await this.flushBuffered();
    await this.sendQueue;
  }

  /** Remove all accepted text that has not yet been handed to `send`. */
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

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.chunks = [];
    this.bytes = 0;
    this.unsentText = "";
  }

  private async flushBuffered(): Promise<void> {
    if (this.chunks.length === 0 || this.disposed) return;
    const text = this.chunks.join("");
    const bytes = this.bytes;
    this.chunks = [];
    this.bytes = 0;
    const sent = this.sendQueue.then(() => this.deliver(text, bytes));
    this.sendQueue = sent.catch(() => undefined);
    await sent;
  }

  private async waitForTimedFlush(): Promise<void> {
    if (this.timedFlush !== null) await this.timedFlush;
  }

  /** `send` may wait arbitrarily long before it actually delivers (or, for
   *  `WorkerDeltaBatcher`, silently drops a batch it was disposed out from
   *  under). `unsentText` must stay untouched for the whole wait, so a
   *  concurrent `takeUnsent()` still sees text `send` never committed to —
   *  it is only removed once `send` has returned and this batch is no
   *  longer eligible to be reclaimed. */
  private async deliver(text: string, bytes: number): Promise<void> {
    await this.send(text, bytes);
    if (this.disposed) return;
    if (!this.unsentText.startsWith(text)) {
      throw new Error("Delta batch queue lost its accepted-text prefix");
    }
    this.unsentText = this.unsentText.slice(text.length);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
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
