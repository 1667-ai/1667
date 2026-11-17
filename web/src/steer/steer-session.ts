/**
 * Ported from chuanqisun/spaceship (MIT), `src/text/main.ts`: the knob's rest
 * and dwell timers, `discardIfBehindRest`, `restartRest` and `topUp`.
 *
 * One steer session: a preview stream and the knob's place in it. The session
 * keeps a buffer of words ahead of the knob. When the knob goes back behind
 * the place where it last rested, the text ahead is discarded and a new
 * request continues from the knob once it rests again.
 */
import { createPreviewStream, type PreviewSource } from "./preview-stream.js";
import { NO_STEERING, type Steering } from "./steering.js";
import { countWords, firstWords } from "./words.js";

/** The knob rests when it has not moved for this long. */
export const REST_MS = 100;
/** Words kept ready past the knob. */
export const BUFFER_WORDS = 300;
/** A request that adds no words is tried again after this long, doubling up to `MAX_RETRY_MS`. */
export const RETRY_MS = 1000;
export const MAX_RETRY_MS = 16000;

export interface SteerSnapshot {
  readonly text: string;
  /** Words at or before the knob. */
  readonly shown: number;
  /** Words the knob can reach. A word that is still arriving does not count. */
  readonly generated: number;
  readonly ahead: number;
  readonly generating: boolean;
  readonly firstChunkMs: number | undefined;
  readonly wordsPerSecond: number | undefined;
  readonly error: string | null;
}

export interface SteerSession {
  snapshot(): SteerSnapshot;
  subscribe(listener: () => void): () => void;
  /** Moves the knob to after word `count`; the knob never passes the generated text. */
  moveTo(count: number): void;
  /** The shown words, trimmed. */
  shownText(): string;
  /** Starts requesting. Safe to call again after `dispose`. */
  start(): void;
  /** Aborts the running request and stops requesting. */
  dispose(): void;
}

export function createSteerSession(source: PreviewSource, steering: Steering = NO_STEERING): SteerSession {
  const listeners = new Set<() => void>();
  const stream = createPreviewStream(source, changed);
  let shown = 0;
  /** Words shown where the knob last rested, or where a move back discarded the text past it. */
  let restCount = 0;
  /** A move back discarded the text ahead. It is generated again once the knob rests, not at every word on the way. */
  let regenerationHeld = false;
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  let topUpTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAt = 0;
  let retryMs = RETRY_MS;
  let error: string | null = null;
  let disposed = false;
  let current = build();

  return { snapshot: () => current, subscribe, moveTo, shownText, start, dispose };

  function generatedWords(): number {
    const { isGenerating, prefixWords } = stream.activity();
    const text = stream.text;
    const total = countWords(text);
    // The last word of a running request may be cut in two: it is not there yet.
    return isGenerating && total > prefixWords && !/\s$/.test(text) ? total - 1 : total;
  }

  function build(): SteerSnapshot {
    const activity = stream.activity();
    const generated = generatedWords();
    return {
      text: stream.text,
      shown,
      generated,
      ahead: Math.max(0, generated - shown),
      generating: activity.isGenerating,
      firstChunkMs: activity.firstChunkMs,
      wordsPerSecond: activity.wordsPerSecond,
      error
    };
  }

  function changed(): void {
    if (disposed) return;
    current = build();
    for (const listener of [...listeners]) listener();
    scheduleTopUp();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function shownText(): string {
    return firstWords(stream.text, shown).trim();
  }

  function moveTo(count: number): void {
    if (disposed) return;
    const next = Math.max(0, Math.min(generatedWords(), Math.round(count)));
    if (next === shown) return;
    shown = next;
    discardIfBehindRest();
    restartRest();
    changed();
  }

  /** Going back past the word the knob rested on means the writer wants another continuation. */
  function discardIfBehindRest(): void {
    if (shown >= restCount) return;
    stream.truncate(shown);
    restCount = shown;
    regenerationHeld = true;
  }

  function restartRest(): void {
    clearTimeout(restTimer);
    restTimer = setTimeout(() => {
      restCount = shown;
      regenerationHeld = false;
      topUp();
    }, REST_MS);
  }

  function scheduleTopUp(): void {
    if (disposed) return;
    topUpTimer ??= setTimeout(() => {
      topUpTimer = undefined;
      topUp();
    });
  }

  function topUp(): void {
    if (disposed || regenerationHeld || stream.activity().isGenerating || performance.now() < retryAt) return;
    const words = countWords(stream.text);
    if (words - shown >= BUFFER_WORDS) return;
    stream.generate(steering).then(
      (outcome) => {
        if (outcome === "done") settleTopUp(words);
      },
      (failure: unknown) => {
        error = failure instanceof Error ? failure.message : String(failure);
        settleTopUp(words);
      }
    );
  }

  /** A request that added words resets the retry delay. One that added none waits before the next, longer each time. */
  function settleTopUp(wordsBefore: number): void {
    if (disposed) return;
    if (countWords(stream.text) > wordsBefore) {
      retryMs = RETRY_MS;
      retryAt = 0;
      error = null;
      changed();
      return;
    }
    retryAt = performance.now() + retryMs;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(scheduleTopUp, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    changed();
  }

  /** A restart begins fresh: `dispose` cleared the timers that would lift a held regeneration or a retry wait. */
  function start(): void {
    disposed = false;
    regenerationHeld = false;
    restCount = shown;
    retryAt = 0;
    retryMs = RETRY_MS;
    scheduleTopUp();
  }

  function dispose(): void {
    disposed = true;
    stream.abort();
    clearTimeout(restTimer);
    clearTimeout(topUpTimer);
    clearTimeout(retryTimer);
    topUpTimer = undefined;
  }
}
