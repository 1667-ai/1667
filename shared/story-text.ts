/** Join at the exact cursor boundary; the continuation owns any separator. */
export function appendContinuationText(current: string, continuation: string): string {
  return `${current}${continuation}`;
}

export function countWords(text: string): number {
  return appendWordCount({ words: 0, insideWord: false }, text).words;
}

/** Stable bytes hashed by both browser and server before an asynchronous
 * summary may replace the reader's launch line. */
export function activeLineFingerprintSource(
  title: string,
  path: readonly { id: string; text: string }[]
): string {
  return JSON.stringify({ title, path: path.map(({ id, text }) => ({ id, text })) });
}

export interface IncrementalWordCount {
  words: number;
  insideWord: boolean;
}

const WORD_SEPARATOR = /\s/u;

/** Count streamed text once, carrying a word across arbitrary delta boundaries. */
export function appendWordCount(state: IncrementalWordCount, delta: string): IncrementalWordCount {
  let { words, insideWord } = state;
  for (const character of delta) {
    if (WORD_SEPARATOR.test(character)) {
      insideWord = false;
    } else if (!insideWord) {
      words += 1;
      insideWord = true;
    }
  }
  return { words, insideWord };
}
