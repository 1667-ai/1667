/** Words of a preview text. A word is a run of non-space characters. */

export function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** The text up to and including its `count`th word, without the space after it. */
export function firstWords(text: string, count: number): string {
  if (count <= 0) return "";
  return text.match(new RegExp(`^(?:\\s*\\S+){${count}}`))?.[0] ?? text;
}

export interface Word {
  readonly text: string;
  /** The white space after the word, kept so the text reads as it was written. */
  readonly gap: string;
}

export interface WordList {
  /** White space before the first word. */
  readonly lead: string;
  readonly words: readonly Word[];
}

export function splitWords(text: string): WordList {
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const words = [...text.matchAll(/(\S+)(\s*)/g)].map((match): Word => ({ text: match[1] ?? "", gap: match[2] ?? "" }));
  return { lead, words };
}
