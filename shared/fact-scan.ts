import { assembleChapterContext, type ChapterPartLike } from "./chapters.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  MAX_FACT_RECURSION_UTF16,
  MAX_FACT_SCAN_UTF16
} from "./fact-metadata.js";
import type { ChapterBreak, StoryNode } from "./types.js";

export interface FactScanContext {
  readonly contextParts: readonly StoryNode[];
  /** Ordered request path used for Fact State resolution. When omitted,
   * `contextParts` is the request path. Keep this separate because a caller
   * can assemble a scan context from a path plus summary nodes. */
  readonly requestPath?: readonly { readonly id: string }[];
  readonly chapterBreaks: readonly ChapterBreak[];
  readonly nodes: readonly ChapterPartLike[];
  readonly instruction?: string;
  readonly selectedText?: string;
}
export interface FactScanSegment {
  readonly text: string;
  readonly folded: string;
  readonly before: string | null;
}
export interface FactScanSource {
  readonly story: readonly string[];
  readonly instruction: string;
  readonly selectedText: string;
}

export function normalizeFactText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function factScanSource(context: FactScanContext): FactScanSource {
  const assembled = assembleChapterContext(context.contextParts, context.chapterBreaks, context.nodes);
  return factScanSourceFromTexts(
    assembled.map((part) => part.text ?? ""),
    context.instruction ?? "",
    context.selectedText ?? ""
  );
}
export function factScanSourceFromTexts(
  story: readonly string[],
  instruction = "",
  selectedText = ""
): FactScanSource {
  return {
    story: story.filter(hasFactScanText),
    instruction,
    selectedText
  };
}
export function windowScanSegments(
  source: FactScanSource,
  depth = DEFAULT_FACT_SCAN_PARTS
): FactScanSegment | null {
  return boundedSegment([
    ...source.story.slice(-depth),
    source.instruction,
    source.selectedText
  ]);
}
export function boundedSegment(parts: readonly string[], max = MAX_FACT_SCAN_UTF16): FactScanSegment | null {
  const source = parts.filter(hasFactScanText).join("\n\n");
  if (source.length === 0) return null;
  if (source.length <= max) return segment(source, null);
  const start = suffixStart(source, source.length - max);
  return segment(source.slice(start), scalarBefore(source, start));
}
export function recursionScanSegment(texts: readonly string[]): FactScanSegment | null {
  return boundedSegment(fairShareRecursionTexts(texts, MAX_FACT_RECURSION_UTF16), MAX_FACT_RECURSION_UTF16);
}

/** Give every active recursion-enabled Fact a bounded, max-min-fair share of
 * the recursion window, so one oversized Fact cannot crowd the rest out of
 * chain matching. `boundedSegment` alone keeps only the *tail* of the joined
 * text — fine when the join already fits, but when it does not, a single
 * Fact placed early can lose its entire contribution to a huge Fact that
 * follows it, even though every other Fact is tiny.
 *
 * When the join already fits in `max` (the common case), this returns
 * `texts` untouched and `boundedSegment` takes its normal, unmodified path —
 * the fair-share pass changes nothing unless the window is actually tight.
 * Only reached over budget: each text keeps at most its water-filling share,
 * taken from its own tail (the same "keep what's most recent" rule
 * `boundedSegment` already applies to the join as a whole). A share of zero
 * drops that Fact from the window entirely, same as today when there are
 * simply too many Facts for the space available. */
function fairShareRecursionTexts(texts: readonly string[], max: number): readonly string[] {
  const nonEmpty = texts.filter(hasFactScanText);
  if (nonEmpty.length === 0) return texts;
  const separators = 2 * (nonEmpty.length - 1);
  const joinedLength = nonEmpty.reduce((sum, text) => sum + text.length, 0) + separators;
  if (joinedLength <= max) return texts;
  const budget = Math.max(0, max - separators);
  const shares = maxMinShares(nonEmpty.map((text) => text.length), budget);
  return nonEmpty.map((text, index) => tailSlice(text, shares[index]!));
}

/** Classic max-min fair-share (water-filling): a text shorter than an equal
 * split keeps its whole length and returns its unused share to the pool,
 * which grows every other text's share in turn. Converges in at most
 * `lengths.length` passes, each of which finalizes at least one text or
 * exits. */
function maxMinShares(lengths: readonly number[], budget: number): number[] {
  const shares = new Array<number>(lengths.length).fill(0);
  const remaining = new Set(lengths.map((_, index) => index));
  let remainingBudget = budget;
  let progressed = true;
  while (progressed && remaining.size > 0) {
    progressed = false;
    const equalShare = Math.floor(remainingBudget / remaining.size);
    for (const index of remaining) {
      if (lengths[index]! <= equalShare) {
        shares[index] = lengths[index]!;
        remainingBudget -= lengths[index]!;
        remaining.delete(index);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) {
    const equalShare = Math.floor(remainingBudget / remaining.size);
    let extra = remainingBudget - equalShare * remaining.size;
    for (const index of remaining) {
      shares[index] = equalShare + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
    }
  }
  return shares;
}

/** The last `limit` UTF-16 units of `text`, aligned so the retained text
 * never starts mid-word — never split between a surrogate pair either, the
 * same rule `boundedSegment`'s own suffix trim uses.
 *
 * A raw tail cut can land inside a word: "xtrigger" cut between "x" and
 * "trigger" hands the matcher a fragment that reads as the whole word
 * "trigger" starting fresh — preceded by nothing (or by another Fact's
 * "\n\n" join separator), both of which pass the boundary check — even
 * though the real text has "x" right there and a real scan would refuse
 * the match. Dropping the partial leading word removes that fabricated
 * boundary along with the rest of the excess. Text that already fits `limit`
 * returns unchanged: only a cut this function actually makes can create an
 * artificial boundary to fix. */
function tailSlice(text: string, limit: number): string {
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  const start = suffixStart(text, text.length - limit);
  return text.slice(skipPartialWord(text, start));
}

/** `start` cuts `text` mid-word when the scalar just before it is a word
 * scalar; advance past the rest of that word (surrogate-safe) so the
 * retained text begins at a real word boundary, same as the text would
 * naturally start after any other non-word character. */
function skipPartialWord(text: string, start: number): number {
  const before = scalarBefore(text, start);
  if (before === null || !isWord(before)) return start;
  let index = start;
  while (index < text.length) {
    const scalar = scalarAt(text, index);
    if (scalar === null || !isWord(scalar)) break;
    index += scalar.length;
  }
  return index;
}
function segment(text: string, before: string | null): FactScanSegment {
  return { text: text.normalize("NFC"), folded: normalizeFactText(text), before };
}
function hasFactScanText(text: string): boolean {
  return text.trim().length > 0;
}
export function literalFactKeyMatches(scan: FactScanSegment, key: string): boolean {
  const foldedKey = normalizeFactText(key);
  let offset = 0;
  while (offset <= scan.folded.length - foldedKey.length) {
    const match = scan.folded.indexOf(foldedKey, offset);
    if (match < 0) return false;
    if (hasBoundaries(scan.folded, match, match + foldedKey.length, foldedKey, match === 0 ? scan.before : undefined)) {
      return true;
    }
    offset = match + Math.max(1, foldedKey.length);
  }
  return false;
}
function hasBoundaries(text: string, start: number, end: number, key: string, preceding?: string | null): boolean {
  const before = preceding === undefined ? scalarBefore(text, start) : preceding;
  const after = scalarAt(text, end);
  const keyHasCjk = [...key].some(isCjk);
  const keyIsCjkPhrase = keyHasCjk && [...key].filter(isWord).every(isCjk);
  return (before === null || !isWord(before) || keyIsCjkPhrase && isCjk(before))
    && (after === null || !isWord(after) || keyIsCjkPhrase && isCjk(after));
}
function scalarBefore(value: string, offset: number): string | null {
  if (offset <= 0) return null;
  const unit = value.charCodeAt(offset - 1);
  const point = unit >= 0xdc00 && unit <= 0xdfff && offset > 1
    ? value.codePointAt(offset - 2)
    : value.codePointAt(offset - 1);
  return point === undefined ? null : String.fromCodePoint(point);
}
function scalarAt(value: string, offset: number): string | null {
  const point = value.codePointAt(offset);
  return point === undefined ? null : String.fromCodePoint(point);
}
function suffixStart(value: string, start: number): number {
  const unit = value.charCodeAt(start);
  return unit >= 0xdc00 && unit <= 0xdfff ? start + 1 : start;
}
function isWord(value: string): boolean { return /^[\p{L}\p{N}\p{M}_]$/u.test(value); }
function isCjk(value: string): boolean { return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(value); }
