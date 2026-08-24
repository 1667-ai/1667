const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// A grapheme occupies zero cells when every scalar in it is a combining mark
// or a zero-width format character: ZWSP, ZWNJ, ZWJ, the bidi marks LRM, RLM,
// and ALM, the Mongolian vowel separator, the word joiner and invisible
// operators, the deprecated format controls, ZWNBSP/BOM, and the tag block.
// The bidi embedding, override, and isolate controls are absent on purpose:
// the strict projection regime draws each as a one-cell control mark
// (shared/terminal-text.ts), so their measured width must stay 1.
const ZERO_WIDTH = /^[\p{Mark}\u061C\u180E\u200B-\u200F\u2060-\u2064\u206A-\u206F\uFEFF\u{E0000}-\u{E007F}]+$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}|\p{Regional_Indicator}/u;
const KEYCAP = /\u20E3/u;
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

/** Maximum UTF-16 units passed to Intl.Segmenter for one presentation probe.
 *  A provider can make one grapheme arbitrarily large with combining marks.
 *  Keep that input bounded even when the pending stream is much larger. */
export const MAX_GRAPHEME_PROBE_UNITS = 256;

// A writer types a no-break space to hold two words on one row, so it is the
// one whitespace a wrap must not break at. U+FEFF is already zero width, and
// it joins the set for the same reason.
const NO_BREAK_SPACE = /[\u00A0\u2007\u202F\uFEFF]/;

/** True when a wrap can break the line at this cell. One spelling for the
 *  story measure and for the composer, so both break a paragraph alike. */
export function breaksLine(text: string): boolean {
  return /\s/.test(text) && !NO_BREAK_SPACE.test(text);
}

export interface GraphemeCell {
  text: string;
  index: number;
  width: number;
}

export function graphemeCells(text: string): GraphemeCell[] {
  return [...iterateGraphemeCells(text)];
}

export interface GraphemePrefixOptions {
  /** Include one atomic grapheme that exceeds the limit. */
  includeOversized?: boolean;
  /** Keep the final grapheme so a later provider delta can extend it. */
  retainLast?: boolean;
}

/** Return a complete grapheme prefix within `limit` UTF-16 units. */
export function graphemePrefixLength(
  text: string,
  limit: number,
  options: GraphemePrefixOptions = {}
): number {
  const { includeOversized = false, retainLast = false } = options;
  const bounded = Math.max(0, Math.min(text.length, Math.floor(limit)));
  if (bounded === 0 || text.length === 0) return 0;
  if (bounded >= text.length && !retainLast) {
    return highSurrogate(text.charCodeAt(text.length - 1)) ? text.length - 1 : text.length;
  }
  if (bounded >= text.length
    && text.length >= 2
    && printableAscii(text.charCodeAt(text.length - 2))
    && printableAscii(text.charCodeAt(text.length - 1))) {
    return text.length - 1;
  }
  if (printableAscii(text.charCodeAt(bounded - 1))
    && printableAscii(text.charCodeAt(bounded))) return bounded;

  // Segment only a bounded probe. A segment whose end touches a truncated
  // probe may continue in the pending text, so keep it quarantined. This is
  // conservative by design: presentation must never draw a partial grapheme
  // merely because a provider supplied an oversized combining sequence.
  let probeEnd = Math.min(text.length, MAX_GRAPHEME_PROBE_UNITS);
  if (highSurrogate(text.charCodeAt(probeEnd - 1))) probeEnd -= 1;
  if (probeEnd <= 0) return 0;
  const probe = text.slice(0, probeEnd);
  const truncated = probeEnd < text.length;
  let boundary = 0;
  let lastStart = 0;
  let previousStart = 0;
  for (const entry of GRAPHEMES.segment(probe)) {
    const end = entry.index + entry.segment.length;
    // The final segment of a truncated probe is not known to be complete.
    // Do not include it as an oversized atomic unit, and do not count it as
    // the last confirmed boundary for a non-terminal presentation step.
    if (end > bounded) {
      const complete = !truncated || end < probeEnd;
      return boundary === 0 && includeOversized && complete ? end : boundary;
    }
    if (truncated && end === probeEnd) return boundary;
    previousStart = lastStart;
    lastStart = entry.index;
    boundary = end;
  }
  if (!retainLast) return boundary;
  return highSurrogate(text.charCodeAt(text.length - 1))
    ? previousStart
    : lastStart;
}

/** Lazy form used by bounded rendering work so large paragraphs can yield
 * without first scanning or materializing the whole range. Keep the last ASCII
 * cell before Unicode in the segmented suffix because a combining mark may
 * join it. */
export function* iterateGraphemeCells(
  text: string,
  start = 0,
  end = text.length
): IterableIterator<GraphemeCell> {
  let index = start;
  while (index < end) {
    const code = text.charCodeAt(index);
    const next = index + 1 < end ? text.charCodeAt(index + 1) : -1;
    if (!printableAscii(code) || index + 1 < end && !printableAscii(next)) break;
    yield { text: text[index]!, index: index - start, width: 1 };
    index += 1;
  }
  if (index >= end) return;
  const segmented = text.slice(index, end);
  for (const entry of GRAPHEMES.segment(segmented)) {
    yield {
      text: entry.segment,
      index: index - start + entry.index,
      width: graphemeWidth(entry.segment)
    };
  }
}

export function cellWidth(text: string): number {
  if (isPrintableAscii(text)) return text.length;
  return graphemeCells(text).reduce((sum, cell) => sum + cell.width, 0);
}

export function isPrintableAscii(text: string): boolean {
  return PRINTABLE_ASCII.test(text);
}

function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 0 || ZERO_WIDTH.test(grapheme)) return 0;
  // OpenTUI's TextBuffer renders each tab as two cells. Keep wrapping,
  // caret placement, and native selection projections on that same metric.
  if (grapheme === "\t") return 2;
  // Extended_Pictographic includes symbols whose default presentation is
  // text (notably ⚑/⚐). Only default-emoji graphemes, explicit emoji
  // variation, flags, and keycaps consume two terminal cells.
  if (EMOJI_PRESENTATION.test(grapheme) || grapheme.includes("\uFE0F") || KEYCAP.test(grapheme)) return 2;
  const codePoint = grapheme.codePointAt(0)!;
  return isFullwidthCodePoint(codePoint) ? 2 : 1;
}

function printableAscii(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

function highSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isFullwidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329 || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
