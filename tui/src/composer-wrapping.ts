import { breaksLine } from "./cell-width.js";
import type { ComposerLineChunk } from "./composer-model.js";
import {
  composerLineChunks,
  composerLineHasWrapSpace,
  composerLineIdentity,
  composerLineLength,
  composerLineSnapshot,
  composerLineUniformWidth,
  composerPosition,
  type ComposerState
} from "./composer-model.js";

export interface WrappedComposerRow {
  sourceIndex: number;
  start: number;
  end: number;
  first: boolean;
  last: boolean;
}

export interface WrappedComposerLayout {
  rowCount: number;
  cursorRow: number;
  rowAt(index: number): WrappedComposerRow | undefined;
}

/** One source line's wrap points. Rows tile the line without gaps, so row `i`
 *  ends where row `i + 1` starts and the final row ends at `length`. Every
 *  column therefore belongs to exactly one row, which is what lets the caret
 *  sit anywhere the writer can type — including inside the run of spaces that
 *  a wrap point absorbs.
 *
 *  A line with no break space wraps at a fixed cell count, so `stride` holds
 *  that count and the row bounds stay arithmetic. Two million cells of one
 *  pasted token therefore cost no row array at all. Prose takes `starts`. */
type WrappedLineMetric =
  | { kind: "stride"; length: number; rowCount: number; stride: number }
  | { kind: "starts"; length: number; rowCount: number; starts: readonly number[] };

interface WrapBlock {
  lines: readonly WrappedLineMetric[];
  rowCount: number;
}

interface CachedWrapStructure {
  revision: number;
  width: number;
  blocks: readonly WrapBlock[];
  rowCount: number;
}

const BLOCK_LINES = 256;
const WRAP_STRUCTURES = new WeakMap<ComposerState, CachedWrapStructure>();
const LINE_METRICS = new WeakMap<object, { width: number; metric: WrappedLineMetric }>();

/** Cell-accurate word wrap shared by paint and visual-row movement. Lines break
 * at the last space that fits, matching the story measure (`wrap.ts`); a word
 * wider than the field falls back to a cell break so a long token still
 * advances. Composer line-change metadata replaces only affected 256-line
 * blocks after edits. */
export function wrappedComposerLayout(
  composer: ComposerState,
  width: number
): WrappedComposerLayout {
  const structure = wrapStructure(composer, width);
  const cursor = composerPosition(composer);
  const cursorMetric = metricAtLine(structure.blocks, cursor.line)!;
  const cursorRow = rowBeforeLine(structure.blocks, cursor.line)
    + localRowForColumn(cursorMetric, cursor.column);
  return {
    rowCount: structure.rowCount,
    cursorRow,
    rowAt: (index) => wrappedRowAt(structure.blocks, structure.rowCount, index)
  };
}

function wrapStructure(composer: ComposerState, width: number): CachedWrapStructure {
  const boundedWidth = Math.max(1, width);
  const snapshot = composerLineSnapshot(composer);
  const cached = WRAP_STRUCTURES.get(composer);
  const change = snapshot.change;
  if (cached?.width === boundedWidth && cached.revision === snapshot.revision) return cached;
  if (cached?.width === boundedWidth && change?.full === false
    && change.baseRevision === cached.revision) {
    const inserted = Array.from({ length: change.inserted }, (_, offset) =>
      metricForLine(composer, change.start + offset, boundedWidth));
    const blocks = spliceBlocks(
      cached.blocks, change.start, change.removed, inserted
    );
    const structure = createStructure(snapshot.revision, boundedWidth, blocks);
    WRAP_STRUCTURES.set(composer, structure);
    return structure;
  }
  const metrics = Array.from({ length: snapshot.lineCount }, (_, line) =>
    metricForLine(composer, line, boundedWidth));
  const structure = createStructure(snapshot.revision, boundedWidth, chunkMetrics(metrics));
  WRAP_STRUCTURES.set(composer, structure);
  return structure;
}

function metricForLine(
  composer: ComposerState,
  sourceIndex: number,
  width: number
): WrappedLineMetric {
  const identity = composerLineIdentity(composer, sourceIndex)!;
  const cached = LINE_METRICS.get(identity);
  if (cached?.width === width) return cached.metric;
  const length = composerLineLength(composer, sourceIndex);
  const uniformWidth = composerLineUniformWidth(composer, sourceIndex);
  const metric = uniformWidth !== null && !composerLineHasWrapSpace(composer, sourceIndex)
    ? strideMetric(length, width, uniformWidth)
    : scannedMetric(composer, sourceIndex, length, width);
  LINE_METRICS.set(identity, { width, metric });
  return metric;
}

/** Rows of a fixed cell count. Without a break space every row holds as many
 *  cells as fit, which is what the arithmetic below states directly. */
function strideMetric(
  length: number,
  width: number,
  uniformWidth: number
): WrappedLineMetric {
  if (length === 0) return { kind: "stride", length, rowCount: 1, stride: 1 };
  const stride = uniformWidth <= 0
    ? Math.max(1, length)
    : Math.max(1, Math.floor(width / uniformWidth));
  const lastRowWidth = (length % stride || stride) * Math.max(0, uniformWidth);
  return {
    kind: "stride",
    length,
    rowCount: Math.ceil(length / stride) + (lastRowWidth >= width ? 1 : 0),
    stride
  };
}

/** Where a scan stands between two chunks. It carries no absolute column, so
 *  an unchanged chunk keeps its answer after an edit anywhere behind it. */
interface ScanState {
  /** Width the current row already holds. */
  used: number;
  /** Width of the run of non-space cells in flight. */
  wordWidth: number;
  /** Cells from here back to where that run began. */
  wordBack: number;
  /** True when the run began after the current row did, so the row can give
   *  the whole run to the next row instead of splitting it. */
  wordAfterRowStart: boolean;
}

interface ChunkWrap {
  /** Row starts inside the chunk, as offsets from its first column. */
  offsets: readonly number[];
  exit: ScanState;
}

const CHUNK_WRAPS = new WeakMap<ComposerLineChunk, Map<string, ChunkWrap>>();

/** Walk the line by chunk and record where each row begins.
 *
 *  A row keeps the spaces that end it, so the writer sees the caret advance
 *  while typing them; those spaces can run past the field, where the field
 *  paint clips them. A word too wide for the field breaks by cell instead, so
 *  a pasted token still advances rather than stalling the wrap.
 *
 *  Each chunk answers for its own cells and the composer keeps chunk objects
 *  across an edit, so a keystroke re-scans only the chunks whose wrap can have
 *  moved. Without this a long paragraph re-scanned every cell per keystroke. */
function scannedMetric(
  composer: ComposerState,
  sourceIndex: number,
  length: number,
  width: number
): WrappedLineMetric {
  const starts = [0];
  let state: ScanState = {
    used: 0,
    wordWidth: 0,
    wordBack: 0,
    wordAfterRowStart: false
  };
  let chunkStart = 0;
  for (const chunk of composerLineChunks(composer, sourceIndex)) {
    const wrap = chunkWrap(chunk, width, state);
    for (const offset of wrap.offsets) starts.push(chunkStart + offset);
    state = wrap.exit;
    chunkStart += chunk.count;
  }
  // An exactly-full final row leaves the caret no cell of its own, so the end
  // of the line gets a row rather than a position off the right edge.
  if (length > 0 && state.used >= width) starts.push(length);
  return { kind: "starts", length, rowCount: starts.length, starts };
}

function chunkWrap(
  chunk: ComposerLineChunk,
  width: number,
  entry: ScanState
): ChunkWrap {
  let cache = CHUNK_WRAPS.get(chunk);
  if (cache === undefined) {
    cache = new Map();
    CHUNK_WRAPS.set(chunk, cache);
  }
  const key = `${width}:${entry.used}:${entry.wordWidth}:${entry.wordBack}:`
    + `${entry.wordAfterRowStart ? 1 : 0}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const wrap = scanChunk(chunk, width, entry);
  cache.set(key, wrap);
  return wrap;
}

function scanChunk(
  chunk: ComposerLineChunk,
  width: number,
  entry: ScanState
): ChunkWrap {
  const offsets: number[] = [];
  let used = entry.used;
  let wordWidth = entry.wordWidth;
  // Negative while the run in flight began in an earlier chunk.
  let wordStart = -entry.wordBack;
  let wordAfterRowStart = entry.wordAfterRowStart;
  let column = 0;
  for (const cell of chunk.cells) {
    if (breaksLine(cell.text)) {
      used += cell.width;
      wordStart = column + 1;
      wordWidth = 0;
      wordAfterRowStart = true;
    } else if (used + cell.width <= width) {
      used += cell.width;
      wordWidth += cell.width;
    } else if (wordAfterRowStart) {
      // Carry the whole word down rather than splitting it.
      offsets.push(wordStart);
      used = wordWidth + cell.width;
      wordWidth = used;
      wordAfterRowStart = false;
    } else {
      // The word alone outgrows the field, so break between its cells.
      offsets.push(column);
      wordStart = column;
      used = cell.width;
      wordWidth = cell.width;
    }
    column += 1;
  }
  return {
    offsets,
    exit: { used, wordWidth, wordBack: column - wordStart, wordAfterRowStart }
  };
}


function createStructure(
  revision: number,
  width: number,
  blocks: readonly WrapBlock[]
): CachedWrapStructure {
  return {
    revision,
    width,
    blocks,
    rowCount: blocks.reduce((sum, block) => sum + block.rowCount, 0)
  };
}

function makeBlock(lines: readonly WrappedLineMetric[]): WrapBlock {
  return { lines, rowCount: lines.reduce((sum, line) => sum + line.rowCount, 0) };
}

function rowStartAt(line: WrappedLineMetric, index: number): number {
  return line.kind === "stride"
    ? Math.min(line.length, index * line.stride)
    : line.starts[index]!;
}

function chunkMetrics(lines: readonly WrappedLineMetric[]): WrapBlock[] {
  const blocks: WrapBlock[] = [];
  for (let index = 0; index < lines.length; index += BLOCK_LINES) {
    blocks.push(makeBlock(lines.slice(index, index + BLOCK_LINES)));
  }
  return blocks;
}

function spliceBlocks(
  blocks: readonly WrapBlock[],
  start: number,
  removed: number,
  inserted: readonly WrappedLineMetric[]
): WrapBlock[] {
  const from = lineBoundary(blocks, start);
  const to = lineBoundary(blocks, start + removed);
  const head = from.block < blocks.length ? blocks[from.block]!.lines.slice(0, from.local) : [];
  const tail = to.block < blocks.length ? blocks[to.block]!.lines.slice(to.local) : [];
  return [
    ...blocks.slice(0, from.block),
    ...chunkMetrics([...head, ...inserted, ...tail]),
    ...blocks.slice(Math.min(blocks.length, to.block + 1))
  ];
}

function lineBoundary(
  blocks: readonly WrapBlock[],
  line: number
): { block: number; local: number } {
  let remaining = Math.max(0, line);
  for (const [block, value] of blocks.entries()) {
    if (remaining < value.lines.length) return { block, local: remaining };
    remaining -= value.lines.length;
  }
  return { block: blocks.length, local: 0 };
}

function metricAtLine(
  blocks: readonly WrapBlock[],
  line: number
): WrappedLineMetric | undefined {
  let remaining = line;
  for (const block of blocks) {
    if (remaining < block.lines.length) return block.lines[remaining];
    remaining -= block.lines.length;
  }
  return undefined;
}

function rowBeforeLine(blocks: readonly WrapBlock[], line: number): number {
  let remaining = line;
  let rows = 0;
  for (const block of blocks) {
    if (remaining >= block.lines.length) {
      remaining -= block.lines.length;
      rows += block.rowCount;
      continue;
    }
    for (let index = 0; index < remaining; index += 1) rows += block.lines[index]!.rowCount;
    return rows;
  }
  return rows;
}

function localRowForColumn(line: WrappedLineMetric, column: number): number {
  if (line.kind === "stride") {
    return Math.min(line.rowCount - 1, Math.max(0, Math.floor(column / line.stride)));
  }
  const starts = line.starts;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= column) low = middle;
    else high = middle - 1;
  }
  return low;
}

function wrappedRowAt(
  blocks: readonly WrapBlock[],
  rowCount: number,
  index: number
): WrappedComposerRow | undefined {
  if (index < 0 || index >= rowCount) return undefined;
  let remaining = index;
  let sourceIndex = 0;
  for (const block of blocks) {
    if (remaining >= block.rowCount) {
      remaining -= block.rowCount;
      sourceIndex += block.lines.length;
      continue;
    }
    for (const line of block.lines) {
      if (remaining >= line.rowCount) {
        remaining -= line.rowCount;
        sourceIndex += 1;
        continue;
      }
      const start = rowStartAt(line, remaining);
      const last = remaining === line.rowCount - 1;
      return {
        sourceIndex,
        start,
        end: last ? line.length : rowStartAt(line, remaining + 1),
        first: start === 0,
        last
      };
    }
  }
  return undefined;
}
