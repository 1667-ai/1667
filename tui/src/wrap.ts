import { graphemeCells, iterateGraphemeCells } from "./cell-width.js";

/** The prose-layer styles carried through wrapping: human-edited spans, spans
 *  a rewrite replaced (issue #319), and the freshly-streaming suffix of an
 *  appended part. The seven logo styles color the hardcoded starter mark
 *  without adding markup to story text. */
export type ProseStyle =
  | "human"
  | "rewritten"
  | "streaming"
  | "logo red"
  | "logo orange"
  | "logo yellow"
  | "logo green"
  | "logo cyan"
  | "logo blue"
  | "logo violet";

export interface StyleRun<Style = string> {
  start: number;
  end: number;
  style: Style;
}

export interface WrappedLine<Style = string> {
  text: string;
  start: number;
  end: number;
  styleRuns: StyleRun<Style>[];
}

/** O(1) identity for immutable payload prose plus one append-only stream. */
export interface WrapContentIdentity {
  source: object;
  stream: object | null;
  streamStart: number;
  streamEnd: number;
  textLength: number;
}

export interface WrapCache<Style = string> {
  wrap(
    partId: string,
    width: number,
    text: string,
    runs: readonly StyleRun<Style>[],
    identity?: WrapContentIdentity
  ): WrappedLine<Style>[];
  /** Warm-path measurement without rebuilding text/style inputs. */
  lineCount(
    partId: string,
    width: number,
    text: string,
    identity?: WrapContentIdentity
  ): number | null;
  isWarm(
    partId: string,
    width: number,
    text: string,
    runs: readonly StyleRun<Style>[],
    identity?: WrapContentIdentity
  ): boolean;
  /** Constant-time lookup; resumable work must validate text/run lineage. */
  appendCandidate(
    partId: string,
    width: number,
    appendStart: number
  ): WrapAppendCandidate<Style> | null;
  prime(
    partId: string,
    width: number,
    text: string,
    runs: readonly StyleRun<Style>[],
    lines: WrappedLine<Style>[],
    identity?: WrapContentIdentity
  ): void;
  invalidate(partId?: string): void;
  /** Keep one part's entries across a payload swap. The caller proves the
   *  part's settled prose is unchanged and names the part's new identity
   *  source. Entries whose recorded text length disagrees stay untouched
   *  and miss naturally; stream-tagged entries still need their full
   *  identity tuple to match before they can hit. */
  rebind(partId: string, source: object, textLength: number): void;
  /** Every part id that currently holds at least one entry. */
  partIds(): string[];
  /** Changes only when complete entries are explicitly invalidated. */
  readonly epoch: number;
  /** Changes whenever an exact cache entry is added, replaced, or invalidated. */
  readonly revision: number;
  readonly hits: number;
  readonly misses: number;
}

export interface WrapAppendCandidate<Style = string> {
  source: readonly WrappedLine<Style>[];
  lineCount: number;
  start: number;
  text: string;
  runs: readonly StyleRun<Style>[];
}

export interface ResumableWrap<Style = string> {
  /** Advance until complete or shouldYield() requests the event loop. */
  advance(shouldYield?: () => boolean): boolean;
  /** Available only after advance() returns true. */
  result(): WrappedLine<Style>[];
}

export function wrapText<Style>(
  text: string,
  styleRuns: readonly StyleRun<Style>[],
  measure: number
): WrappedLine<Style>[] {
  if (!Number.isInteger(measure) || measure < 1) throw new Error("Wrap measure must be a positive integer.");
  if (text.length === 0) return [{ text: "", start: 0, end: 0, styleRuns: [] }];

  const normalizedRuns = normalizedStyleRuns(styleRuns, text);
  const bounds: Array<{ start: number; end: number }> = [];
  let paragraphStart = 0;
  while (paragraphStart <= text.length) {
    const newline = text.indexOf("\n", paragraphStart);
    const paragraphEnd = newline === -1 ? text.length : newline;
    wrapParagraph(text, paragraphStart, paragraphEnd, measure, bounds, normalizedRuns);
    if (newline === -1) break;
    if (paragraphEnd === paragraphStart) bounds.push({ start: paragraphStart, end: paragraphStart });
    paragraphStart = newline + 1;
    if (paragraphStart === text.length) bounds.push({ start: paragraphStart, end: paragraphStart });
  }

  return bounds.map(({ start, end }) => ({
    text: text.slice(start, end),
    start,
    end,
    styleRuns: clipRuns(normalizedRuns, start, end)
  }));
}

/** Same wrapping semantics as wrapText(), but large grapheme segmentation,
 * line breaking, and styled-line materialization can stop between slices. */
export function createResumableWrap<Style>(
  text: string,
  styleRuns: readonly StyleRun<Style>[],
  measure: number
): ResumableWrap<Style> {
  if (!Number.isInteger(measure) || measure < 1) throw new Error("Wrap measure must be a positive integer.");
  if (text.length === 0) {
    const empty = [{ text: "", start: 0, end: 0, styleRuns: [] as StyleRun<Style>[] }];
    return { advance: () => true, result: () => empty };
  }

  const bounds: Array<{ start: number; end: number }> = [];
  const lines: WrappedLine<Style>[] = [];
  const normalizedRuns: StyleRun<Style>[] = [];
  const boundaryRefs = new Map<number, Array<{
    run: number;
    edge: "start" | "end";
  }>>();
  let phase:
    | "normalize-runs"
    | "find-newline"
    | "segment"
    | "align-cell"
    | "wrap"
    | "materialize-lines"
    | "materialize-runs"
    | "done" = "normalize-runs";
  let sourceRun = 0;
  let paragraphStart = 0;
  let paragraphEnd = 0;
  let newline = -1;
  let newlineScan = 0;
  let cells: ReturnType<typeof graphemeCells> = [];
  let segments: Iterator<ReturnType<typeof graphemeCells>[number]> | null = null;
  let pendingCell: ReturnType<typeof graphemeCells>[number] | null = null;
  let alignmentOffset = 0;
  let alignmentEnd = 0;
  let alignmentTarget = 0;
  let alignmentAfter: "segment" | "wrap" = "segment";
  let cell = 0;
  let bound = 0;
  let materialRun = 0;
  let materialLine = -1;

  const addBoundary = (offset: number, run: number, edge: "start" | "end") => {
    const refs = boundaryRefs.get(offset) ?? [];
    refs.push({ run, edge });
    boundaryRefs.set(offset, refs);
  };
  const normalizeNextRun = () => {
    const source = styleRuns[sourceRun++]!;
    const run = { ...source };
    if (text[run.start - 1] === "\r" && text[run.start] === "\n") run.start -= 1;
    if (text[run.end - 1] === "\r" && text[run.end] === "\n") run.end -= 1;
    const index = normalizedRuns.push(run) - 1;
    addBoundary(run.start, index, "start");
    addBoundary(run.end, index, "end");
  };

  const startParagraph = () => {
    newline = -1;
    paragraphEnd = paragraphStart;
    newlineScan = paragraphStart;
    cells = [];
    segments = null;
    pendingCell = null;
    cell = 0;
    phase = "find-newline";
  };
  const startSegmentation = () => {
    segments = iterateGraphemeCells(text, paragraphStart, paragraphEnd)[Symbol.iterator]();
    phase = "segment";
  };
  const finishParagraph = () => {
    if (newline === -1) return void (phase = "materialize-lines");
    if (paragraphEnd === paragraphStart) bounds.push({ start: paragraphStart, end: paragraphStart });
    paragraphStart = newline + 1;
    if (paragraphStart === text.length) {
      bounds.push({ start: paragraphStart, end: paragraphStart });
      phase = "materialize-lines";
    } else {
      startParagraph();
    }
  };
  const alignBetweenCells = (
    from: number,
    to: number,
    target: number,
    nextCell: ReturnType<typeof graphemeCells>[number] | null,
    after: "segment" | "wrap"
  ) => {
    alignmentOffset = from;
    alignmentEnd = to;
    alignmentTarget = target;
    pendingCell = nextCell;
    alignmentAfter = after;
    phase = "align-cell";
  };

  return {
    advance(shouldYield = () => false) {
      let operations = 0;
      const yieldNow = () => ++operations % 64 === 0 && shouldYield();
      while (phase !== "done") {
        if (phase === "normalize-runs") {
          if (sourceRun < styleRuns.length) {
            normalizeNextRun();
            if (yieldNow()) return false;
            continue;
          }
          startParagraph();
        }
        if (phase === "find-newline") {
          while (newlineScan < text.length && text.charCodeAt(newlineScan) !== 0x0a) {
            newlineScan += 1;
            if (yieldNow()) return false;
          }
          newline = newlineScan < text.length ? newlineScan : -1;
          paragraphEnd = newline === -1 ? text.length : newline;
          startSegmentation();
        }
        if (phase === "segment") {
          const next = segments!.next();
          if (!next.done) {
            const previous = cells.at(-1);
            if (previous === undefined) {
              cells.push(next.value);
              if (yieldNow()) return false;
            } else {
              const previousStart = paragraphStart + previous.index;
              alignBetweenCells(
                previousStart + 1,
                paragraphStart + next.value.index,
                previousStart,
                next.value,
                "segment"
              );
            }
            continue;
          }
          segments = null;
          const previous = cells.at(-1);
          if (previous === undefined) {
            phase = "wrap";
          } else {
            const previousStart = paragraphStart + previous.index;
            alignBetweenCells(
              previousStart + 1,
              paragraphEnd,
              previousStart,
              null,
              "wrap"
            );
          }
        }
        if (phase === "align-cell") {
          while (alignmentOffset < alignmentEnd) {
            const refs = boundaryRefs.get(alignmentOffset);
            if (refs !== undefined) {
              for (const ref of refs) normalizedRuns[ref.run]![ref.edge] = alignmentTarget;
            }
            alignmentOffset += 1;
            if (yieldNow()) return false;
          }
          const alignedCell = pendingCell;
          pendingCell = null;
          phase = alignmentAfter;
          if (alignedCell !== null) {
            cells.push(alignedCell);
            if (yieldNow()) return false;
          }
          continue;
        }
        if (phase === "wrap") {
          while (cell < cells.length && cells[cell]!.text === " ") {
            cell += 1;
            if (yieldNow()) return false;
          }
          const next = nextWrappedLine(cells, cell, paragraphStart, paragraphEnd, measure);
          if (next === null) {
            finishParagraph();
          } else {
            bounds.push(next.bound);
            cell = next.cell;
            if (yieldNow()) return false;
          }
          continue;
        }
        if (phase === "materialize-lines") {
          const item = bounds[bound++];
          if (item === undefined) {
            phase = "materialize-runs";
            continue;
          }
          lines.push({
            text: text.slice(item.start, item.end),
            start: item.start,
            end: item.end,
            styleRuns: []
          });
          if (yieldNow()) return false;
        }
        if (phase === "materialize-runs") {
          const run = normalizedRuns[materialRun];
          if (run === undefined) {
            phase = "done";
            continue;
          }
          if (run.end <= run.start) {
            materialRun += 1;
            if (yieldNow()) return false;
            continue;
          }
          if (materialLine < 0) materialLine = firstBoundEndingAfter(bounds, run.start);
          const item = bounds[materialLine];
          if (item === undefined || item.start >= run.end) {
            materialRun += 1;
            materialLine = -1;
            if (yieldNow()) return false;
            continue;
          }
          const clippedStart = Math.max(item.start, run.start);
          const clippedEnd = Math.min(item.end, run.end);
          if (clippedEnd > clippedStart) {
            lines[materialLine]!.styleRuns.push({
              start: clippedStart - item.start,
              end: clippedEnd - item.start,
              style: run.style
            });
          }
          materialLine += 1;
          if (yieldNow()) return false;
        }
      }
      return true;
    },
    result() {
      if (phase !== "done") throw new Error("Wrap result requested before completion.");
      return lines;
    }
  };
}

function firstBoundEndingAfter(
  bounds: readonly { start: number; end: number }[],
  offset: number
): number {
  let low = 0;
  let high = bounds.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bounds[middle]!.end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Segment the paragraph once and walk grapheme cells by index — every
 *  per-line operation is O(line), keeping the whole wrap O(paragraph). */
function wrapParagraph<Style>(
  text: string,
  start: number,
  end: number,
  measure: number,
  output: Array<{ start: number; end: number }>,
  styleRuns: StyleRun<Style>[]
): void {
  if (start === end) return;
  const cells = graphemeCells(text.slice(start, end));
  alignStyleRunBoundaries(styleRuns, cells, start, end);
  let cell = 0;
  while (true) {
    const next = nextWrappedLine(cells, cell, start, end, measure);
    if (next === null) return;
    output.push(next.bound);
    cell = next.cell;
  }
}

/** Style cannot split a terminal grapheme. Resolve each raw code-unit
 * boundary while wrapping already owns the paragraph's segmentation work. */
function alignStyleRunBoundaries<Style>(
  runs: StyleRun<Style>[],
  cells: ReturnType<typeof graphemeCells>,
  start: number,
  end: number
): void {
  if (runs.length === 0 || cells.length === 0) return;
  const align = (offset: number) => {
    if (offset <= start || offset >= end) return offset;
    const relative = offset - start;
    let low = 0;
    let high = cells.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (cells[middle]!.index <= relative) low = middle + 1;
      else high = middle - 1;
    }
    return start + cells[Math.max(0, high)]!.index;
  };
  for (const run of runs) {
    run.start = align(run.start);
    run.end = align(run.end);
  }
}

function normalizedStyleRuns<Style>(
  runs: readonly StyleRun<Style>[],
  text: string
): StyleRun<Style>[] {
  const normalized = copyRuns(runs);
  for (const run of normalized) {
    if (text[run.start - 1] === "\r" && text[run.start] === "\n") run.start -= 1;
    if (text[run.end - 1] === "\r" && text[run.end] === "\n") run.end -= 1;
  }
  return normalized;
}

function nextWrappedLine(
  cells: ReturnType<typeof graphemeCells>,
  from: number,
  start: number,
  end: number,
  measure: number
): { cell: number; bound: { start: number; end: number } } | null {
  const position = (index: number): number => index >= cells.length ? end : start + cells[index]!.index;
  let cell = from;
  while (cell < cells.length && cells[cell]!.text === " ") cell += 1;
  if (cell >= cells.length) return null;
  let width = 0;
  let fitted = cell;
  while (fitted < cells.length && width + cells[fitted]!.width <= measure) {
    width += cells[fitted]!.width;
    fitted += 1;
  }
  if (fitted >= cells.length) {
    return { cell: cells.length, bound: { start: position(cell), end } };
  }
  if (fitted === cell) fitted = cell + 1;
  let breakCell = -1;
  for (let probe = fitted; probe > cell; probe -= 1) {
    if (probe < cells.length && /\s/.test(cells[probe]!.text)) {
      breakCell = probe;
      break;
    }
  }
  if (breakCell === -1) breakCell = fitted;
  let visibleCell = breakCell;
  while (visibleCell > cell && cells[visibleCell - 1]!.text === " ") visibleCell -= 1;
  return {
    cell: breakCell,
    bound: { start: position(cell), end: position(visibleCell) }
  };
}

function clipRuns<Style>(runs: readonly StyleRun<Style>[], start: number, end: number): StyleRun<Style>[] {
  return runs.flatMap((run): StyleRun<Style>[] => {
    const clippedStart = Math.max(start, run.start);
    const clippedEnd = Math.min(end, run.end);
    if (clippedEnd <= clippedStart) return [];
    return [{ start: clippedStart - start, end: clippedEnd - start, style: run.style }];
  });
}

export function createWrapCache<Style>(): WrapCache<Style> {
  interface CacheEntry {
    text: string;
    runs: readonly StyleRun<Style>[];
    lines: WrappedLine<Style>[];
    identity: WrapContentIdentity | undefined;
  }
  const parts = new Map<string, Map<number, CacheEntry>>();
  let hits = 0;
  let misses = 0;
  let epoch = 0;
  let revision = 0;
  const entryFor = (partId: string, width: number) => parts.get(partId)?.get(width);
  const store = (partId: string, width: number, entry: CacheEntry) => {
    let widths = parts.get(partId);
    if (widths === undefined) parts.set(partId, widths = new Map());
    widths.set(width, entry);
  };
  const contentExact = (
    cached: { text: string; identity: WrapContentIdentity | undefined } | undefined,
    text: string,
    identity: WrapContentIdentity | undefined
  ) => cached !== undefined && (identity === undefined
    ? cached.text === text
    : cached.identity !== undefined && sameIdentity(cached.identity, identity));
  const exact = (
    cached: {
      text: string;
      runs: readonly StyleRun<Style>[];
      identity: WrapContentIdentity | undefined;
    } | undefined,
    text: string,
    runs: readonly StyleRun<Style>[],
    identity: WrapContentIdentity | undefined
  ) => contentExact(cached, text, identity)
    && sameRuns(cached!.runs, runs);
  return {
    wrap(partId, width, text, runs, identity) {
      const cached = entryFor(partId, width);
      if (exact(cached, text, runs, identity)) {
        hits += 1;
        return cached!.lines;
      }
      misses += 1;
      const wrapped = wrapText(text, runs, width);
      store(partId, width, {
        text,
        runs: copyRuns(runs),
        lines: wrapped,
        identity: copyIdentity(identity)
      });
      revision += 1;
      return wrapped;
    },
    lineCount(partId, width, text, identity) {
      const cached = entryFor(partId, width);
      return contentExact(cached, text, identity) ? cached!.lines.length : null;
    },
    isWarm(partId, width, text, runs, identity) {
      return exact(entryFor(partId, width), text, runs, identity);
    },
    appendCandidate(partId, width, appendStart) {
      const cached = entryFor(partId, width);
      const last = cached?.lines.at(-1);
      if (cached === undefined || last === undefined
        || last.start === 0
        || cached.text.length < appendStart) {
        return null;
      }
      return {
        source: cached.lines,
        lineCount: cached.lines.length - 1,
        start: last.start,
        text: cached.text,
        runs: cached.runs
      };
    },
    prime(partId, width, text, runs, lines, identity) {
      if (exact(entryFor(partId, width), text, runs, identity)) return;
      misses += 1;
      store(partId, width, {
        text,
        runs: copyRuns(runs),
        lines,
        identity: copyIdentity(identity)
      });
      revision += 1;
    },
    invalidate(partId) {
      epoch += 1;
      revision += 1;
      if (partId === undefined) return void parts.clear();
      parts.delete(partId);
    },
    rebind(partId, source, textLength) {
      const widths = parts.get(partId);
      if (widths === undefined) return;
      for (const entry of widths.values()) {
        if (entry.identity?.textLength === textLength) entry.identity.source = source;
      }
    },
    partIds: () => [...parts.keys()],
    get epoch() { return epoch; },
    get revision() { return revision; },
    get hits() { return hits; },
    get misses() { return misses; }
  };
}

function sameIdentity(left: WrapContentIdentity, right: WrapContentIdentity): boolean {
  return left.source === right.source
    && left.stream === right.stream
    && left.streamStart === right.streamStart
    && left.streamEnd === right.streamEnd
    && left.textLength === right.textLength;
}

function copyIdentity(
  identity: WrapContentIdentity | undefined
): WrapContentIdentity | undefined {
  return identity === undefined ? undefined : { ...identity };
}

function sameRuns<Style>(left: readonly StyleRun<Style>[], right: readonly StyleRun<Style>[]): boolean {
  return left.length === right.length && left.every((run, index) => {
    const other = right[index]!;
    return run.start === other.start && run.end === other.end && Object.is(run.style, other.style);
  });
}

function copyRuns<Style>(runs: readonly StyleRun<Style>[]): StyleRun<Style>[] {
  return runs.map((run) => ({ ...run }));
}
