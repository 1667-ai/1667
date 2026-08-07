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

  constructor(
    private readonly send: (text: string, bytes: number) => Promise<void>
  ) {}

  async push(text: string): Promise<void> {
    for (const chunk of splitUtf8(text, MAX_DELTA_BATCH_BYTES)) {
      await this.waitForTimedFlush();
      const bytes = byteLength(chunk);
      if (this.bytes > 0 && this.bytes + bytes > MAX_DELTA_BATCH_BYTES) await this.flush();
      this.chunks.push(chunk);
      this.bytes += bytes;
      if (this.bytes >= MAX_DELTA_BATCH_BYTES) await this.flush();
      else if (this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null;
          const flushing = this.flushBuffered();
          this.timedFlush = flushing;
          const clearTimedFlush = () => {
            if (this.timedFlush === flushing) this.timedFlush = null;
          };
          flushing.then(clearTimedFlush, clearTimedFlush);
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

  /** Remove all text that has been accepted but not yet handed to `send`.
   *  A batch already handed to `send` is not buffered here any more — a
   *  caller that also needs to reclaim a batch `send` has not committed to
   *  yet (for example a credit wait) must track that itself; see
   *  `WorkerDeltaBatcher.sealUnsent`. */
  takeBuffered(): string {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const text = this.chunks.join("");
    this.chunks = [];
    this.bytes = 0;
    return text;
  }

  dispose(): void {
    this.takeBuffered();
  }

  /** Flush the buffered batch, if any, through the send queue. The drain of
   *  `chunks` happens inside the queued continuation, at the same step that
   *  hands the batch to `send`. This keeps a batch either in `chunks` or
   *  inside that one synchronous step — never in neither place, where
   *  `takeBuffered` could not find it. */
  private async flushBuffered(): Promise<void> {
    if (this.chunks.length === 0) return;
    const sent = this.sendQueue.then(() => {
      if (this.chunks.length === 0) return;
      const text = this.chunks.join("");
      const bytes = this.bytes;
      this.chunks = [];
      this.bytes = 0;
      return this.send(text, bytes);
    });
    this.sendQueue = sent.catch(() => undefined);
    await sent;
  }

  private async waitForTimedFlush(): Promise<void> {
    if (this.timedFlush !== null) await this.timedFlush;
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function splitUtf8(value: string, maxBytes: number): string[] {
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
