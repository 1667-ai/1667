import { MAX_FACT_TAG_CHARS, MAX_FACT_TEXT_CHARS } from "./types.js";
import {
  alignUtf16Boundary,
  sliceUnicodeScalarPrefix,
  unicodeScalarLength
} from "./unicode.js";

/** The one scalar-count contract for Fact text and Fact tags.
 *
 * Server admission (server/story-facts.ts) and importer truncation
 * (shared/lorebook-entry.ts, server/import-nai.ts) both measure here, so an
 * importer can never produce a Fact the server then refuses. Both limits count
 * Unicode scalar values. Fact text used to count UTF-16 code units, which
 * undercounted astral text; the scalar measure admits more and loosening the
 * stored limit that way is a product decision, not an accident. */
export function factTextWithinLimit(value: string): boolean {
  return unicodeScalarLength(value, MAX_FACT_TEXT_CHARS) <= MAX_FACT_TEXT_CHARS;
}

export function factTagWithinLimit(value: string): boolean {
  return unicodeScalarLength(value, MAX_FACT_TAG_CHARS) <= MAX_FACT_TAG_CHARS;
}

export function truncateFactTag(value: string): string {
  return sliceUnicodeScalarPrefix(value, MAX_FACT_TAG_CHARS);
}

/** Cut Fact text to the scalar limit: at the last paragraph break, then line
 * break, then word break at or past half the limit, and never between
 * surrogates. Text within the limit returns unchanged. */
export function truncateFactText(text: string): string {
  if (factTextWithinLimit(text)) return text;
  const cap = sliceUnicodeScalarPrefix(text, MAX_FACT_TEXT_CHARS).length;
  const floor = sliceUnicodeScalarPrefix(text, Math.floor(MAX_FACT_TEXT_CHARS / 2)).length;
  let cut = lastBoundary(text, "\n\n", floor, cap);
  if (cut === -1) cut = lastBoundary(text, "\n", floor, cap);
  if (cut === -1) {
    cut = cap;
    for (let index = cap - 1; index >= floor; index -= 1) {
      if (/\s/u.test(text[index]!)) {
        cut = index + 1;
        break;
      }
    }
  }
  return text.slice(0, alignUtf16Boundary(text, cut)).trimEnd();
}

function lastBoundary(text: string, boundary: string, start: number, end: number): number {
  for (let index = end - boundary.length; index >= start; index -= 1) {
    if (text.startsWith(boundary, index)) return index + boundary.length;
  }
  return -1;
}
