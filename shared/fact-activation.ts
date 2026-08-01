import {
  assembleChapterContext,
  type ChapterPartLike
} from "./chapters.js";
import { hasUnpairedSurrogate, unicodeScalarLength } from "./unicode.js";
import type { ChapterBreak, StoryFact, StoryNode } from "./types.js";

export const FACT_ACTIVATIONS = ["always", "keyed"] as const;
export type FactActivation = (typeof FACT_ACTIVATIONS)[number];

export const MAX_FACT_KEYS = 32;
export const MAX_FACT_KEY_SCALARS = 64;
export const MAX_FACT_SCAN_PARTS = 3;
export const MAX_FACT_SCAN_UTF16 = 20_000;

export class FactActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactActivationError";
  }
}

export interface FactMetadata {
  activation: FactActivation;
  keys: string[];
}

/** Parse metadata at a boundary that accepts legacy omission. */
export function parseFactMetadata(
  activationValue: unknown,
  keysValue: unknown,
  label = "Fact"
): FactMetadata {
  const activation = activationValue === undefined
    ? "always"
    : parseFactActivation(activationValue, `${label} activation`);
  const keys = keysValue === undefined
    ? []
    : parseFactKeys(keysValue, `${label} keys`);
  return { activation, keys };
}

export function parseFactActivation(value: unknown, label = "Fact activation"): FactActivation {
  if (value !== "always" && value !== "keyed") {
    throw new FactActivationError(`${label} must be "always" or "keyed"`);
  }
  return value;
}

export function parseFactKeys(value: unknown, label = "Fact keys"): string[] {
  if (!Array.isArray(value)) throw new FactActivationError(`${label} must be an array`);
  if (value.length > MAX_FACT_KEYS) {
    throw new FactActivationError(`${label} exceeds the ${MAX_FACT_KEYS}-key limit`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (typeof candidate !== "string") {
      throw new FactActivationError(`${label}[${index}] must be a string`);
    }
    if (candidate.length === 0 || candidate.trim().length === 0) {
      throw new FactActivationError(`${label}[${index}] must not be empty`);
    }
    if (candidate.includes(",")) {
      throw new FactActivationError(`${label}[${index}] must not contain a comma`);
    }
    if (/[\r\n\u2028\u2029]/u.test(candidate)) {
      throw new FactActivationError(`${label}[${index}] must be a single line`);
    }
    if (hasUnpairedSurrogate(candidate)) {
      throw new FactActivationError(`${label}[${index}] contains invalid Unicode`);
    }
    if (unicodeScalarLength(candidate, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
      throw new FactActivationError(
        `${label}[${index}] exceeds the ${MAX_FACT_KEY_SCALARS}-character limit`
      );
    }
    const normalized = normalizeFactText(candidate);
    if (unicodeScalarLength(normalized, MAX_FACT_KEY_SCALARS + 1) > MAX_FACT_KEY_SCALARS) {
      throw new FactActivationError(
        `${label}[${index}] exceeds the ${MAX_FACT_KEY_SCALARS}-character limit after normalization`
      );
    }
    if (seen.has(normalized)) {
      throw new FactActivationError(`${label}[${index}] duplicates another key`);
    }
    seen.add(normalized);
    return candidate;
  });
}

export interface FactScanContext {
  /** The exact path passed to the request's context assembler. */
  contextParts: readonly StoryNode[];
  chapterBreaks: readonly ChapterBreak[];
  nodes: readonly ChapterPartLike[];
  instruction?: string;
  selectedText?: string;
}

interface FactScan {
  text: string;
  /** Scalar immediately before a capped suffix, kept outside searchable text. */
  before: string | null;
}

/** Select Facts in stored insertion order. Omitted context means always-only. */
export function selectActiveFacts(
  facts: readonly StoryFact[],
  context?: FactScanContext
): StoryFact[] {
  const scan = context === undefined ? null : factScanText(context);
  return selectFactsForScan(facts, scan);
}

/** Build the exact assembled context used for a rewrite's activation scan. */
export function assembleRewriteContext<Node extends ChapterPartLike>(
  path: readonly StoryNode[],
  partId: string,
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly Node[]
): Array<StoryNode | Node> {
  const targetIndex = path.findIndex((part) => part.id === partId);
  if (targetIndex < 0) throw new Error(`Unknown rewrite part: ${partId}`);
  return assembleChapterContext(
    path.slice(0, targetIndex + 1),
    chapterBreaks.filter((chapterBreak) => chapterBreak.parentPartId !== partId),
    nodes
  );
}

export function selectActiveFactsForRewrite<Node extends ChapterPartLike>(
  facts: readonly StoryFact[],
  path: readonly StoryNode[],
  partId: string,
  chapterBreaks: readonly ChapterBreak[],
  nodes: readonly Node[],
  instruction: string,
  selectedText: string
): StoryFact[] {
  const assembled = assembleRewriteContext(path, partId, chapterBreaks, nodes);
  const scan = boundedScanText([
    ...lastNonEmptyPartTexts(assembled),
    instruction,
    selectedText
  ]);
  return selectFactsForScan(facts, scan);
}

function selectFactsForScan(
  facts: readonly StoryFact[],
  scan: FactScan | null
): StoryFact[] {
  return facts.filter((fact) => fact.activation === "always"
    || (scan !== null && fact.keys.some((key) => containsFactKey(scan, key))));
}

function factScanText(context: FactScanContext): FactScan | null {
  const assembled = assembleChapterContext(context.contextParts, context.chapterBreaks, context.nodes);
  return boundedScanText([
    ...lastNonEmptyPartTexts(assembled),
    context.instruction ?? "",
    context.selectedText ?? ""
  ]);
}

function lastNonEmptyPartTexts(parts: readonly ChapterPartLike[]): string[] {
  return parts
    .filter((part) => (part.text ?? "").trim().length > 0)
    .slice(-MAX_FACT_SCAN_PARTS)
    .map((part) => part.text ?? "");
}

function boundedScanText(parts: readonly string[]): FactScan | null {
  const source = parts.filter((part) => part.length > 0).join("\n\n");
  if (source.length === 0) return null;
  if (source.length <= MAX_FACT_SCAN_UTF16) {
    return { text: normalizeFactText(source), before: null };
  }
  const start = suffixStart(source, source.length - MAX_FACT_SCAN_UTF16);
  return {
    text: normalizeFactText(source.slice(start)),
    before: scalarBefore(source, start)
  };
}

function containsFactKey(scan: FactScan, key: string): boolean {
  const text = scan.text;
  const normalizedKey = normalizeFactText(key);
  let offset = 0;
  while (offset <= text.length - normalizedKey.length) {
    const match = text.indexOf(normalizedKey, offset);
    if (match < 0) return false;
    if (hasFactBoundaries(
      text,
      match,
      match + normalizedKey.length,
      normalizedKey,
      match === 0 ? scan.before : undefined
    )) return true;
    offset = match + Math.max(1, normalizedKey.length);
  }
  return false;
}

function hasFactBoundaries(
  text: string,
  start: number,
  end: number,
  key: string,
  precedingScalar?: string | null
): boolean {
  const before = precedingScalar === undefined
    ? scalarBefore(text, start)
    : precedingScalar;
  const after = scalarAt(text, end);
  const keyHasCjk = [...key].some(isCjkScalar);
  const keyIsCjkPhrase = keyHasCjk
    && [...key].filter(isWordScalar).every(isCjkScalar);
  const leftAllowed = before === null || !isWordScalar(before)
    || (keyIsCjkPhrase && isCjkScalar(before));
  const rightAllowed = after === null || !isWordScalar(after)
    || (keyIsCjkPhrase && isCjkScalar(after));
  return leftAllowed && rightAllowed;
}

export function normalizeFactText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function suffixStart(value: string, start: number): number {
  const unit = value.charCodeAt(start);
  return isLowSurrogate(unit) ? start + 1 : start;
}

function scalarBefore(value: string, offset: number): string | null {
  if (offset <= 0) return null;
  const unit = value.charCodeAt(offset - 1);
  const codePoint = isLowSurrogate(unit) && offset > 1
    ? value.codePointAt(offset - 2)
    : value.codePointAt(offset - 1);
  if (codePoint === undefined) return null;
  return String.fromCodePoint(codePoint);
}

function scalarAt(value: string, offset: number): string | null {
  const codePoint = value.codePointAt(offset);
  return codePoint === undefined ? null : String.fromCodePoint(codePoint);
}

function isWordScalar(value: string): boolean {
  return /^[\p{L}\p{N}\p{M}_]$/u.test(value);
}

function isCjkScalar(value: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(value);
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
