import {
  appendWordCount,
  WORD_COUNT_START,
  type IncrementalWordCount
} from "../../shared/story-text.js";
import type { StreamView } from "./state.js";
import {
  streamPresentedText,
  streamPresentedTrimBounds
} from "./stream-text.js";

interface WordEffects {
  fromBoundary: IncrementalWordCount;
  fromWord: IncrementalWordCount;
}

interface PresentedWordEffects {
  rawLength: number;
  trimmedEnd: number;
  raw: WordEffects;
  trimmed: WordEffects;
}

const PRESENTED_WORD_EFFECTS = new WeakMap<StreamView, PresentedWordEffects>();

/** Apply the visible stream word effect without rescanning after payload
 * adoption. Trimmed mode matches new takes and rewrite replacements. */
export function appendPresentedWordEffect(
  state: IncrementalWordCount,
  stream: StreamView,
  trimmed: boolean
): IncrementalWordCount {
  const effects = presentedWordEffects(stream);
  const source = trimmed ? effects.trimmed : effects.raw;
  const effect = state.insideWord ? source.fromWord : source.fromBoundary;
  return {
    words: state.words + effect.words,
    insideWord: effect.insideWord
  };
}

function presentedWordEffects(stream: StreamView): PresentedWordEffects {
  const text = streamPresentedText(stream);
  const bounds = streamPresentedTrimBounds(stream);
  const effects = PRESENTED_WORD_EFFECTS.get(stream) ?? {
    rawLength: 0,
    trimmedEnd: 0,
    raw: emptyWordEffects(),
    trimmed: emptyWordEffects()
  };
  if (text.length > effects.rawLength) {
    appendWordEffects(effects.raw, text.slice(effects.rawLength));
    effects.rawLength = text.length;
  }
  if (bounds.end > effects.trimmedEnd) {
    const start = effects.trimmedEnd === 0 ? bounds.start : effects.trimmedEnd;
    appendWordEffects(effects.trimmed, text.slice(start, bounds.end));
    effects.trimmedEnd = bounds.end;
  }
  PRESENTED_WORD_EFFECTS.set(stream, effects);
  return effects;
}

function emptyWordEffects(): WordEffects {
  return {
    fromBoundary: WORD_COUNT_START,
    fromWord: { words: 0, insideWord: true }
  };
}

function appendWordEffects(effects: WordEffects, text: string): void {
  effects.fromBoundary = appendWordCount(effects.fromBoundary, text);
  effects.fromWord = appendWordCount(effects.fromWord, text);
}
