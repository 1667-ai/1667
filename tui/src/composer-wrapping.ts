import {
  composerLineChunks,
  composerLineIdentity,
  composerLineLength,
  composerLineSnapshot,
  composerLineUniformWidth,
  composerPosition,
  type ComposerLineChunk,
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

interface WrappedLineMetric {
  length: number;
  rowCount: number;
  cellsPerRow: number | null;
  mixed: MixedLineMetric | null;
}

interface MixedLineMetric {
  width: number;
  endFull: boolean;
  finalRow: number;
  checkpoints: readonly MixedLineCheckpoint[];
}

interface MixedLineCheckpoint {
  chunk: ComposerLineChunk;
  column: number;
  row: number;
  used: number;
  rowStart: number;
}

interface ChunkTransition {
  rows: number;
  used: number;
  lastRowStart: number;
}

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
const CHUNK_TRANSITIONS = new WeakMap<object, Map<string, ChunkTransition>>();

/** Cell-accurate soft-wrap index shared by paint and visual-row movement.
 * Uniform-width prose uses arithmetic bounds. Composer line-change metadata
 * replaces only affected 256-line blocks after edits. */
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
  const cellsPerRow = uniformWidth === null
    ? null
    : uniformWidth <= 0 ? Math.max(1, length) : Math.max(1, Math.floor(width / uniformWidth));
  const mixed = cellsPerRow === null
    ? mixedLineMetric(composer, sourceIndex, width)
    : null;
  const endFull = mixed?.endFull
    ?? uniformEndUsed(length, cellsPerRow, uniformWidth) >= width;
  const rowCount = length === 0 ? 1
    : mixed !== null ? mixed.finalRow + 1 + (endFull ? 1 : 0)
      : Math.ceil(length / cellsPerRow!) + (endFull ? 1 : 0);
  const metric = {
    length,
    rowCount,
    cellsPerRow,
    mixed
  };
  LINE_METRICS.set(identity, { width, metric });
  return metric;
}

function uniformEndUsed(
  length: number,
  cellsPerRow: number | null,
  cellWidth: number | null
): number {
  return cellsPerRow === null || cellWidth === null || length === 0
    ? 0
    : (length % cellsPerRow || cellsPerRow) * cellWidth;
}

function mixedLineMetric(
  composer: ComposerState,
  sourceIndex: number,
  width: number
): MixedLineMetric {
  const checkpoints: MixedLineCheckpoint[] = [];
  let column = 0;
  let row = 0;
  let used = 0;
  let rowStart = 0;
  for (const chunk of composerLineChunks(composer, sourceIndex)) {
    checkpoints.push({ chunk, column, row, used, rowStart });
    const transition = chunkTransition(chunk, width, used);
    row += transition.rows;
    used = transition.used;
    if (transition.lastRowStart >= 0) rowStart = column + transition.lastRowStart;
    column += chunk.count;
  }
  return { width, endFull: used >= width, finalRow: row, checkpoints };
}

function chunkTransition(
  chunk: ComposerLineChunk,
  width: number,
  startingUsed: number
): ChunkTransition {
  if (chunk.uniformWidth !== null) {
    return uniformChunkTransition(chunk.count, chunk.uniformWidth, width, startingUsed);
  }
  let cache = CHUNK_TRANSITIONS.get(chunk);
  if (cache === undefined) {
    cache = new Map();
    CHUNK_TRANSITIONS.set(chunk, cache);
  }
  const key = `${width}:${startingUsed}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const transition = scanChunkTransition(chunk, width, startingUsed);
  cache.set(key, transition);
  return transition;
}

function scanChunkTransition(
  chunk: ComposerLineChunk,
  width: number,
  startingUsed: number
): ChunkTransition {
  let rows = 0;
  let used = startingUsed;
  let lastRowStart = -1;
  for (const [column, cell] of chunk.cells.entries()) {
    if (used > 0 && used + cell.width > width) {
      rows += 1;
      used = 0;
      lastRowStart = column;
    }
    used += cell.width;
  }
  return { rows, used, lastRowStart };
}

function uniformChunkTransition(
  count: number,
  cellWidth: number,
  width: number,
  startingUsed: number
): ChunkTransition {
  if (count === 0 || cellWidth <= 0) {
    return { rows: 0, used: startingUsed, lastRowStart: -1 };
  }
  let rows = 0;
  let used = startingUsed;
  let column = 0;
  let lastRowStart = -1;
  if (used > 0) {
    const capacity = cellWidth > width
      ? 0
      : Math.max(0, Math.floor((width - used) / cellWidth));
    if (count <= capacity) return {
      rows: 0,
      used: used + count * cellWidth,
      lastRowStart: -1
    };
    column = capacity;
    rows = 1;
    used = 0;
    lastRowStart = column;
  }
  const remaining = count - column;
  const cellsPerRow = cellWidth > width ? 1 : Math.max(1, Math.floor(width / cellWidth));
  const additionalRows = Math.floor((remaining - 1) / cellsPerRow);
  rows += additionalRows;
  if (additionalRows > 0) lastRowStart = column + additionalRows * cellsPerRow;
  used = ((remaining - 1) % cellsPerRow + 1) * cellWidth;
  return { rows, used, lastRowStart };
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
  if (line.cellsPerRow !== null) {
    return Math.min(line.rowCount - 1, Math.floor(column / line.cellsPerRow));
  }
  const mixed = line.mixed!;
  if (line.length === 0 || column <= 0) return 0;
  if (column >= line.length && mixed.endFull) return line.rowCount - 1;
  const checkpoint = checkpointForColumn(mixed.checkpoints, column);
  if (checkpoint === undefined) return 0;
  let row = checkpoint.row;
  let used = checkpoint.used;
  let at = checkpoint.column;
  for (const cell of checkpoint.chunk.cells) {
    if (used > 0 && used + cell.width > mixed.width) {
      row += 1;
      used = 0;
    }
    if (at >= column) break;
    used += cell.width;
    at += 1;
  }
  return row;
}

function checkpointForColumn(
  checkpoints: readonly MixedLineCheckpoint[],
  column: number
): MixedLineCheckpoint | undefined {
  if (checkpoints.length === 0) return undefined;
  let low = 0;
  let high = checkpoints.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (checkpoints[middle]!.column <= column) low = middle;
    else high = middle - 1;
  }
  return checkpoints[low];
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
      const bounds = line.cellsPerRow === null
        ? mixedRowBounds(line, remaining)
        : {
          start: Math.min(line.length, remaining * line.cellsPerRow),
          end: Math.min(line.length, (remaining + 1) * line.cellsPerRow)
        };
      return {
        sourceIndex,
        ...bounds,
        first: bounds.start === 0,
        last: remaining === line.rowCount - 1
      };
    }
  }
  return undefined;
}

function mixedRowBounds(
  line: WrappedLineMetric,
  targetRow: number
): { start: number; end: number } {
  const mixed = line.mixed!;
  if (line.length === 0) return { start: 0, end: 0 };
  if (mixed.endFull && targetRow === line.rowCount - 1) {
    return { start: line.length, end: line.length };
  }
  const checkpoints = mixed.checkpoints;
  let low = 0;
  let high = checkpoints.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (checkpoints[middle]!.row <= targetRow) low = middle;
    else high = middle - 1;
  }
  const checkpoint = checkpoints[low]!;
  let row = checkpoint.row;
  let used = checkpoint.used;
  let rowStart = checkpoint.rowStart;
  let column = checkpoint.column;
  for (let chunk = low; chunk < checkpoints.length; chunk += 1) {
    for (const cell of checkpoints[chunk]!.chunk.cells) {
      if (used > 0 && used + cell.width > mixed.width) {
        if (row === targetRow) return { start: rowStart, end: column };
        row += 1;
        used = 0;
        rowStart = column;
      }
      used += cell.width;
      column += 1;
    }
  }
  return { start: rowStart, end: line.length };
}
