import {
  MAX_HUMAN_EDIT_RANGES,
  MAX_REWRITTEN_SPANS,
  type HumanEditAttribution,
  type StoryNode,
  type TextRange
} from "./types.js";

/** A bounded token diff: exact around ordinary edits, one conservative span
 * for enormous replacements. Ranges refer to the edited text. */
export function humanEditAttribution(before: string, after: string): HumanEditAttribution {
  if (before === after) return { source: "human", ranges: [] };
  const beforeTokens = tokens(before);
  const afterTokens = tokens(after);
  const matches = matchingTokens(beforeTokens, afterTokens);
  if (matches === null) {
    return attributionWithDeletions(
      fallbackRanges(before, after),
      deletedCharactersBetween(before, after)
    );
  }

  const ranges: TextRange[] = [];
  let beforeCursor = 0;
  let afterCursor = 0;
  let deletedCharacters = 0;
  for (const [beforeToken, afterToken] of matches) {
    addVisibleRange(ranges, after, afterCursor, afterToken.start);
    deletedCharacters += deletedCharactersBetween(
      before.slice(beforeCursor, beforeToken.start),
      after.slice(afterCursor, afterToken.start)
    );
    beforeCursor = beforeToken.end;
    afterCursor = afterToken.end;
  }
  addVisibleRange(ranges, after, afterCursor, after.length);
  deletedCharacters += deletedCharactersBetween(before.slice(beforeCursor), after.slice(afterCursor));

  return attributionWithDeletions(
    ranges.length <= MAX_HUMAN_EDIT_RANGES ? ranges : fallbackRanges(before, after),
    deletedCharacters
  );
}

export function activeHumanAttribution(node: StoryNode): HumanEditAttribution | null {
  return node.attribution ?? null;
}

/** True when a `HumanEditAttribution` reflects an edit a reader should see —
 *  either a visible span or a deletion-only edit, which leaves no range
 *  behind but still carries `deletedCharacters`. An attribution with neither
 *  (a no-op save) is not an edit. */
export function humanEditIsMeaningful(attribution: HumanEditAttribution | null | undefined): boolean {
  if (attribution == null) return false;
  return attribution.ranges.length > 0 || (attribution.deletedCharacters ?? 0) > 0;
}

/** Carry earlier human spans through another author edit, then merge the new
 * changes. This preserves authorship across successive saves of one take. */
export function attributionAfterHumanEdit(
  attribution: HumanEditAttribution | null | undefined,
  before: string,
  after: string
): HumanEditAttribution {
  const introduced = humanEditAttribution(before, after);
  if (attribution == null) return introduced;
  const preserved = transformTextRanges(attribution.ranges, before, after);
  const ranges = boundedRanges([...preserved, ...introduced.ranges]);
  const deletedCharacters = Math.min(
    Number.MAX_SAFE_INTEGER,
    (attribution.deletedCharacters ?? 0) + (introduced.deletedCharacters ?? 0)
  );
  return attributionWithDeletions(ranges, deletedCharacters);
}

/** Preserve human-written spans outside a model-rewritten selection. */
export function attributionAfterReplacement(
  attribution: HumanEditAttribution | null,
  start: number,
  end: number,
  replacementLength: number,
  originalLength: number
): HumanEditAttribution | null {
  if (attribution === null || (start === 0 && end === originalLength)) return null;
  const ranges = rangesAfterReplacement(attribution.ranges, start, end, replacementLength);
  // Preserve an existing deletion-only lineage, but do not manufacture one
  // when the model rewrite consumed every concrete human-written span.
  if (attribution.ranges.length > 0 && ranges.length === 0) return null;
  return {
    source: "human",
    ranges,
    ...(attribution.deletedCharacters === undefined
      ? {}
      : { deletedCharacters: attribution.deletedCharacters })
  };
}

/** Move a set of ranges through an arbitrary edit the same way a splice moves
 *  attribution: ranges before the diverging point are untouched, ranges after
 *  it shift by the length delta, and ranges the edit overwrote are truncated
 *  or dropped. Nothing here is human-specific — `rewrittenSpansAfterHumanEdit`
 *  reuses it for rewritten spans instead of duplicating the diff arithmetic. */
export function transformTextRanges(
  ranges: readonly TextRange[],
  before: string,
  after: string
): TextRange[] {
  let transformed = ranges.map((range) => ({ ...range }));
  const matches = matchingTokens(tokens(before), tokens(after));
  if (matches === null) {
    const { prefix, afterEnd } = commonEdges(before, after);
    const suffix = after.length - afterEnd;
    return rangesAfterReplacement(
      transformed,
      prefix,
      before.length - suffix,
      afterEnd - prefix
    );
  }
  let beforeCursor = 0;
  let afterCursor = 0;
  let shift = 0;
  for (const [beforeToken, afterToken] of matches) {
    const beforeGap = before.slice(beforeCursor, beforeToken.start);
    const afterGap = after.slice(afterCursor, afterToken.start);
    if (beforeGap !== afterGap) {
      transformed = rangesAfterReplacement(
        transformed,
        beforeCursor + shift,
        beforeToken.start + shift,
        afterGap.length
      );
      shift += afterGap.length - beforeGap.length;
    }
    beforeCursor = beforeToken.end;
    afterCursor = afterToken.end;
  }
  const beforeGap = before.slice(beforeCursor);
  const afterGap = after.slice(afterCursor);
  if (beforeGap !== afterGap) {
    transformed = rangesAfterReplacement(
      transformed,
      beforeCursor + shift,
      before.length + shift,
      afterGap.length
    );
  }
  return transformed;
}

function rangesAfterReplacement(
  ranges: readonly TextRange[],
  start: number,
  end: number,
  replacementLength: number
): TextRange[] {
  const shift = replacementLength - (end - start);
  const transformed: TextRange[] = [];
  for (const range of ranges) {
    if (range.end <= start) {
      transformed.push({ ...range });
      continue;
    }
    if (range.start >= end) {
      transformed.push({ start: range.start + shift, end: range.end + shift });
      continue;
    }
    if (range.start < start) transformed.push({ start: range.start, end: start });
    if (range.end > end) {
      transformed.push({ start: start + replacementLength, end: range.end + shift });
    }
  }
  return transformed;
}

function boundedRanges(ranges: readonly TextRange[], max = MAX_HUMAN_EDIT_RANGES): TextRange[] {
  const sorted = ranges
    .filter((range) => range.start < range.end)
    .map((range) => ({ ...range }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: TextRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) {
      merged.push(range);
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  if (merged.length <= max) return merged;
  return [{ start: merged[0]!.start, end: merged.at(-1)!.end }];
}

/** Remove `cut` from `ranges` without a second interval algorithm: replacing
 *  a span with itself (same start, end, and length) is exactly the identity
 *  splice `rangesAfterReplacement` already performs — no shift, just the
 *  truncate-or-drop it does for any range the replacement window touches.
 *  Used below by `rewrittenSpansAfterHumanEdit`, over one node's full edit
 *  history rather than per frame. `storyPartWrapPlan`
 *  (tui/src/screens/story/row-layout.ts) used to reuse this too, for its
 *  per-render provenance-run subtraction, but calling it once per run
 *  against the other family's full list cost O(runs × cuts) allocations on
 *  that render-path call; it now keeps its own two-pointer sweep
 *  (`subtractAscending`) for that ascending, pairwise-disjoint case instead
 *  (Fix 1, issue #319 review), so this stays module-private again. */
function subtractRanges(ranges: readonly TextRange[], cut: readonly TextRange[]): TextRange[] {
  let remaining = ranges.map((range) => ({ ...range }));
  for (const range of cut) {
    if (range.start >= range.end) continue;
    remaining = rangesAfterReplacement(remaining, range.start, range.end, range.end - range.start);
  }
  return remaining;
}

/** A rewrite's own replacement, merged with any earlier rewritten spans
 *  carried through the same splice — the same shift-or-truncate arithmetic
 *  `attributionAfterReplacement` uses for human ranges, because a model's
 *  overwrite is the same range surgery, just attributed differently. Unlike
 *  human attribution, a whole-node replacement is not nulled out: the entire
 *  new text is still a rewrite, whatever the old text was. */
export function rewrittenSpansAfterReplacement(
  spans: readonly TextRange[] | null | undefined,
  start: number,
  end: number,
  replacementLength: number
): TextRange[] {
  const carried = spans == null || spans.length === 0
    ? []
    : rangesAfterReplacement(spans, start, end, replacementLength);
  return boundedRanges([...carried, { start, end: start + replacementLength }], MAX_REWRITTEN_SPANS);
}

/** Carry rewritten spans through a human edit exactly like human spans move,
 *  then give the writer back whatever they just touched: prose the writer
 *  edits is theirs now, so it stops being a rewritten span the same instant
 *  `humanEditAttribution` marks it human. */
export function rewrittenSpansAfterHumanEdit(
  spans: readonly TextRange[] | null | undefined,
  before: string,
  after: string
): TextRange[] {
  if (spans == null || spans.length === 0) return [];
  const transformed = transformTextRanges(spans, before, after);
  const reclaimed = humanEditAttribution(before, after).ranges;
  return boundedRanges(subtractRanges(transformed, reclaimed), MAX_REWRITTEN_SPANS);
}

interface Token {
  text: string;
  start: number;
  end: number;
}

type TokenMatch = readonly [before: Token, after: Token];

/** Myers' shortest-edit-path algorithm handles a few edits in a very long part
 * without allocating an O(before * after) matrix. A wholly different rewrite
 * falls back after a bounded edit distance. */
function matchingTokens(before: readonly Token[], after: readonly Token[]): TokenMatch[] | null {
  const maximum = before.length + after.length;
  const frontier = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  const distanceLimit = Math.min(maximum, 512);
  for (let distance = 0; distance <= distanceLimit; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? -1;
      const rightBase = frontier.get(diagonal - 1) ?? -1;
      let beforeIndex = diagonal === -distance
        || (diagonal !== distance && rightBase < down)
        ? down
        : rightBase + 1;
      let afterIndex = beforeIndex - diagonal;
      while (
        beforeIndex < before.length
        && afterIndex < after.length
        && before[beforeIndex]!.text === after[afterIndex]!.text
      ) {
        beforeIndex += 1;
        afterIndex += 1;
      }
      frontier.set(diagonal, beforeIndex);
      if (beforeIndex >= before.length && afterIndex >= after.length) {
        return backtrackMatches(trace, distance, before, after);
      }
    }
  }
  return null;
}

function backtrackMatches(
  trace: readonly Map<number, number>[],
  distance: number,
  before: readonly Token[],
  after: readonly Token[]
): TokenMatch[] {
  const matches: TokenMatch[] = [];
  let beforeIndex = before.length;
  let afterIndex = after.length;
  for (let step = distance; step >= 0; step -= 1) {
    const frontier = trace[step]!;
    const diagonal = beforeIndex - afterIndex;
    const previousDiagonal = step === 0
      ? 0
      : diagonal === -step
        || (diagonal !== step
          && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1))
        ? diagonal + 1
        : diagonal - 1;
    const previousBefore = step === 0 ? 0 : frontier.get(previousDiagonal) ?? 0;
    const previousAfter = previousBefore - previousDiagonal;
    while (
      beforeIndex > previousBefore
      && afterIndex > previousAfter
      && before[beforeIndex - 1]!.text === after[afterIndex - 1]!.text
    ) {
      matches.push([before[beforeIndex - 1]!, after[afterIndex - 1]!]);
      beforeIndex -= 1;
      afterIndex -= 1;
    }
    beforeIndex = previousBefore;
    afterIndex = previousAfter;
  }
  return matches.reverse();
}

function tokens(text: string): Token[] {
  // Whitespace stays in the gaps between semantic anchors. This avoids a run
  // of identical spaces winning the LCS over the unchanged words around it.
  const pattern = /[\p{L}\p{M}\p{N}]+(?:['’_-][\p{L}\p{M}\p{N}]+)*|[^\p{L}\p{M}\p{N}\s]+/gu;
  return [...text.matchAll(pattern)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
}

function addVisibleRange(ranges: TextRange[], text: string, start: number, end: number): void {
  const value = text.slice(start, end);
  const leading = /^\s*/u.exec(value)?.[0].length ?? 0;
  const trailing = /\s*$/u.exec(value)?.[0].length ?? 0;
  const visibleStart = start + leading;
  const visibleEnd = end - trailing;
  if (visibleStart < visibleEnd) ranges.push({ start: visibleStart, end: visibleEnd });
}

function attributionWithDeletions(ranges: TextRange[], deletedCharacters: number): HumanEditAttribution {
  return {
    source: "human",
    ranges,
    ...(deletedCharacters === 0 ? {} : { deletedCharacters })
  };
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const MAX_GRAPHEME_DIFF_CELLS = 65_536;

/** Count removals from a shortest character edit while treating emoji and
 * combining sequences as one visible character. Ordinary token anchors keep
 * these matrices tiny; pathological replacements conservatively remove the
 * whole unmatched before-span. */
function deletedCharactersBetween(before: string, after: string): number {
  if (before === after || before.length === 0) return 0;
  const beforeCharacters = graphemes(before);
  const afterCharacters = graphemes(after);
  let prefix = 0;
  while (
    prefix < beforeCharacters.length
    && prefix < afterCharacters.length
    && beforeCharacters[prefix] === afterCharacters[prefix]
  ) {
    prefix += 1;
  }
  let beforeEnd = beforeCharacters.length;
  let afterEnd = afterCharacters.length;
  while (
    beforeEnd > prefix
    && afterEnd > prefix
    && beforeCharacters[beforeEnd - 1] === afterCharacters[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const beforeLength = beforeEnd - prefix;
  const afterLength = afterEnd - prefix;
  if (beforeLength === 0) return 0;
  if (afterLength === 0 || beforeLength * afterLength > MAX_GRAPHEME_DIFF_CELLS) return beforeLength;

  let previous = new Uint32Array(afterLength + 1);
  for (let beforeIndex = 0; beforeIndex < beforeLength; beforeIndex += 1) {
    const current = new Uint32Array(afterLength + 1);
    for (let afterIndex = 0; afterIndex < afterLength; afterIndex += 1) {
      current[afterIndex + 1] = beforeCharacters[prefix + beforeIndex] === afterCharacters[prefix + afterIndex]
        ? previous[afterIndex]! + 1
        : Math.max(previous[afterIndex + 1]!, current[afterIndex]!);
    }
    previous = current;
  }
  return beforeLength - previous[afterLength]!;
}

function graphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (entry) => entry.segment);
}

function fallbackRanges(before: string, after: string): TextRange[] {
  const { prefix, afterEnd } = commonEdges(before, after);
  const ranges: TextRange[] = [];
  addVisibleRange(ranges, after, prefix, afterEnd);
  return ranges;
}

function commonEdges(before: string, after: string): { prefix: number; afterEnd: number } {
  let prefix = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (prefix < sharedLength && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  if (splitsSurrogate(after, prefix)) prefix -= 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before.charCodeAt(before.length - suffix - 1) === after.charCodeAt(after.length - suffix - 1)
  ) {
    suffix += 1;
  }
  if (splitsSurrogate(after, after.length - suffix)) suffix -= 1;
  return { prefix, afterEnd: after.length - suffix };
}

function splitsSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const left = text.charCodeAt(index - 1);
  const right = text.charCodeAt(index);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}
