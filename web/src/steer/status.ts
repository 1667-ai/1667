import type { SteerSnapshot } from "./steer-session.js";
import { splitWords } from "./words.js";

const CONTEXT_WORDS = 120;

/** The last words of the line end, so a long part does not push the preview off the page. */
export function trimContext(text: string): string {
  const { words } = splitWords(text);
  if (words.length <= CONTEXT_WORDS) return text.trim();
  return `…${words.slice(-CONTEXT_WORDS).map((word) => word.text + word.gap).join("").trim()}`;
}

/** `3 shown · 12 ahead · first words 420 ms · 14.2 words/s · writing…` */
export function formatStatus(snapshot: SteerSnapshot): string {
  const parts = [`${snapshot.shown} shown`, `${snapshot.ahead} ahead`];
  if (snapshot.firstChunkMs !== undefined) {
    parts.push(`first words ${Math.round(snapshot.firstChunkMs)} ms`);
    if (snapshot.wordsPerSecond !== undefined) parts.push(`${snapshot.wordsPerSecond.toFixed(1)} words/s`);
  }
  if (snapshot.generating) parts.push("writing…");
  return parts.join(" · ");
}
