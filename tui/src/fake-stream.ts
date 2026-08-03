export interface FakeStreamOptions {
  wpm?: number;
  signal?: AbortSignal;
  seed?: number;
  /** Floor under the per-chunk delay, in milliseconds. Defaults to 8ms,
   *  which reads as human typing but also caps the stream at roughly 125
   *  chunks per second regardless of `wpm` — too slow to exercise a fast
   *  provider or a high-rate HTTP stream. A caller that needs a sustained
   *  rate above that ceiling lowers this instead of reinventing a second
   *  fake stream (issue #337). */
  minDelayMs?: number;
}

export async function* streamFake(text: string, options: FakeStreamOptions = {}): AsyncGenerator<string> {
  const wpm = options.wpm ?? 700;
  const minDelayMs = options.minDelayMs ?? 8;
  const aborted = () => options.signal?.aborted ?? false;
  let seed = options.seed ?? 1667;
  let offset = 0;
  while (offset < text.length && !aborted()) {
    seed = (seed * 48271) % 0x7fffffff;
    const size = 2 + (seed % 7);
    const chunk = text.slice(offset, offset + size);
    offset += chunk.length;
    const words = Math.max(0.25, chunk.trim().split(/\s+/).filter(Boolean).length);
    const jitter = 0.75 + (seed % 51) / 100;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(minDelayMs, (60_000 / wpm) * words * jitter)));
    if (aborted()) break;
    yield chunk;
  }
}
