export interface FakeStreamOptions {
  wpm?: number;
  signal?: AbortSignal;
  seed?: number;
}

export async function* streamFake(text: string, options: FakeStreamOptions = {}): AsyncGenerator<string> {
  const wpm = options.wpm ?? 700;
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
    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(8, (60_000 / wpm) * words * jitter)));
    if (aborted()) break;
    yield chunk;
  }
}
