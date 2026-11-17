/**
 * Ported from chuanqisun/spaceship (MIT), `src/text/text-stream.ts`.
 *
 * The preview text and the one request that extends it. The text only grows
 * by streamed chunks, or shrinks when it is cut back to a word. A cut aborts
 * the running request, and a late chunk of an aborted request is dropped.
 */
import type { Steering } from "./steering.js";
import { countWords, firstWords } from "./words.js";

/** How a call to `generate` ended: `busy` if a request was running, `aborted` if a cut or a stop ended it. */
export type GenerationOutcome = "busy" | "aborted" | "done";

export interface PreviewSource {
  /** Streams text that continues `prefix`. Stops, by returning or throwing, once `signal` aborts. */
  complete(prefix: string, steering: Steering, signal: AbortSignal): AsyncIterable<string>;
}

/** How the latest request went. `words` counted after the first chunk, so the rate measures streaming and not latency. */
export interface StreamActivity {
  readonly isGenerating: boolean;
  /** Words of the text when the running (or last) request started. */
  readonly prefixWords: number;
  readonly firstChunkMs?: number;
  readonly wordsPerSecond?: number;
}

interface Timing {
  readonly startedAt: number;
  readonly prefixWords: number;
  firstChunkAt?: number;
  lastChunkAt?: number;
  words: number;
}

export interface PreviewStream {
  readonly text: string;
  /** Continues the text from its end; never rewrites it. Rejects if the source fails. */
  generate(steering: Steering): Promise<GenerationOutcome>;
  /** Cuts the text back to its first `count` words and aborts the running request. */
  truncate(count: number): void;
  /** Aborts the running request and keeps the text. */
  abort(): void;
  activity(): StreamActivity;
}

/** `onChange` runs whenever the text changes and when a request ends. */
export function createPreviewStream(source: PreviewSource, onChange: () => void): PreviewStream {
  let text = "";
  let active: AbortController | undefined;
  let timing: Timing | undefined;

  const stream: PreviewStream = {
    get text() {
      return text;
    },
    generate,
    truncate(count) {
      abort();
      text = firstWords(text, count);
    },
    abort,
    activity() {
      if (timing === undefined) return { isGenerating: false, prefixWords: 0 };
      const { startedAt, firstChunkAt, lastChunkAt, words, prefixWords } = timing;
      const streamingMs = firstChunkAt === undefined || lastChunkAt === undefined ? 0 : lastChunkAt - firstChunkAt;
      return {
        isGenerating: active !== undefined,
        prefixWords,
        ...(firstChunkAt === undefined ? {} : { firstChunkMs: firstChunkAt - startedAt }),
        ...(streamingMs > 0 ? { wordsPerSecond: (words * 1000) / streamingMs } : {})
      };
    }
  };
  return stream;

  function abort(): void {
    if (active === undefined) return;
    active.abort();
    active = undefined;
  }

  async function generate(steering: Steering): Promise<GenerationOutcome> {
    if (active !== undefined) return "busy";
    const controller = (active = new AbortController());
    const { signal } = controller;
    const prefix = text;
    const started: Timing = { startedAt: performance.now(), prefixWords: countWords(prefix), words: 0 };
    timing = started;
    try {
      for await (const chunk of source.complete(prefix, steering, signal)) {
        if (signal.aborted) return "aborted";
        const now = performance.now();
        if (started.firstChunkAt === undefined) started.firstChunkAt = now;
        else started.words += countWords(chunk);
        started.lastChunkAt = now;
        text += chunk;
        onChange();
      }
      return signal.aborted ? "aborted" : "done";
    } catch (error) {
      if (!signal.aborted) throw error;
      return "aborted";
    } finally {
      if (active === controller) {
        active = undefined;
        onChange();
      }
    }
  }
}
