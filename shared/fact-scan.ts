import { assembleChapterContext, type ChapterPartLike } from "./chapters.js";
import {
  DEFAULT_FACT_SCAN_PARTS,
  MAX_FACT_RECURSION_UTF16,
  MAX_FACT_SCAN_UTF16
} from "./fact-metadata.js";
import type { ChapterBreak, StoryNode } from "./types.js";

export interface FactScanContext {
  readonly contextParts: readonly StoryNode[];
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
  return boundedSegment(texts, MAX_FACT_RECURSION_UTF16);
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
