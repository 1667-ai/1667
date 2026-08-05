import { graphemeCells } from "./cell-width.js";

export interface ComposerState {
  text: string;
  /** User-perceived grapheme offset into `text`, including line breaks. */
  cursor: number;
  /** Fixed end of the active selection; null when movement owns only a caret. */
  anchor: number | null;
  fullscreen: boolean;
  /** Explicit second-press consent when OSC 52 cannot confirm a cut. */
  cutConfirmation: ComposerCutConfirmation | null;
}

export interface ComposerSelection { start: number; end: number }

export interface ComposerCutConfirmation extends ComposerSelection {
  text: string;
}

export interface ComposerLineSelection extends ComposerSelection {
  lineBreak: boolean;
}

export interface ComposerPosition {
  line: number;
  column: number;
}

export interface ComposerLineCell {
  text: string;
  width: number;
}

/** Stable chunk summaries let wrapping skip unchanged runs after local edits. */
export interface ComposerLineChunk {
  readonly cells: readonly ComposerLineCell[];
  readonly count: number;
  readonly width: number;
  readonly uniformWidth: number | null;
}

export interface ComposerLineChange {
  baseRevision: number;
  revision: number;
  start: number;
  removed: number;
  inserted: number;
  full: boolean;
}

export interface ComposerLineSnapshot {
  revision: number;
  change: ComposerLineChange | null;
  lineCount: number;
}

interface CellChunk extends ComposerLineChunk {
  width: number;
  codeUnits: number;
  uniformWidth: number | null;
}

interface IndexedLine {
  chunks: readonly CellChunk[];
  chunkStarts: readonly number[];
  count: number;
  width: number;
  codeUnits: number;
  breakAfter: string | null;
  uniformWidth: number | null;
}

interface ComposerDocument {
  sourceText: string;
  lines: IndexedLine[];
  lineStarts: number[];
  codeUnitStarts: number[];
  cursorSeen: number;
  cursorLine: number;
  cursorColumn: number;
  preferredX: number | null;
  revision: number;
  lineChange: ComposerLineChange | null;
}

const CHUNK_SIZE = 512;
const EDIT_CONTEXT = 8;
const MAX_SEAM_PROBES = 8;
const MAX_HISTORY_ENTRIES = 200;
// JavaScript strings can occupy two bytes/code unit. This keeps retained undo
// text around 64 MiB while still allowing one maximum-size clipboard paste.
const MAX_HISTORY_CODE_UNITS = 32 * 1024 * 1024;
const DOCUMENTS = new WeakMap<ComposerState, ComposerDocument>();
const EDIT_HISTORIES = new WeakMap<ComposerState, EditHistory>();

interface EditEntry {
  startCodeUnit: number;
  removed: string;
  inserted: string;
  beforeCursor: number;
  beforeAnchor: number | null;
  afterCursor: number;
  afterAnchor: number | null;
}

interface OwnedEditEntry extends EditEntry {
  owner: ComposerState;
}

/** Optional final caret/selection recorded into redo history for a range replace. */
export interface ComposerEditCaret {
  cursor: number;
  anchor?: number | null;
}

interface EditHistory {
  undo: OwnedEditEntry[];
  redo: OwnedEditEntry[];
  retainedCodeUnits: number;
}

export function createComposer(text = ""): ComposerState {
  const composer: ComposerState = {
    text,
    cursor: 0,
    anchor: null,
    fullscreen: false,
    cutConfirmation: null
  };
  const document = buildDocument(text);
  DOCUMENTS.set(composer, document);
  setCursor(composer, document, totalGraphemes(document), false);
  return composer;
}

export function setComposerText(composer: ComposerState, text: string): void {
  const previous = documentFor(composer);
  composer.text = text;
  composer.anchor = null;
  composer.cutConfirmation = null;
  const document = rebuildDocument(text, previous);
  DOCUMENTS.set(composer, document);
  setCursor(composer, document, totalGraphemes(document), false);
  resetComposerEditHistory(composer);
}

export function insertComposerText(composer: ComposerState, text: string): void {
  const document = documentFor(composer);
  const selection = composerSelection(composer);
  if (text.length === 0 && selection === null) return;
  replaceComposerRange(
    composer, document, selection?.start ?? composer.cursor, selection?.end ?? composer.cursor, text
  );
}

export function backspaceComposer(composer: ComposerState): void {
  const document = documentFor(composer);
  const selection = composerSelection(composer);
  if (selection !== null) return replaceComposerRange(composer, document, selection.start, selection.end, "");
  if (composer.cursor <= 0) return;
  replaceComposerRange(composer, document, composer.cursor - 1, composer.cursor, "");
}

export function deleteComposerForward(composer: ComposerState): void {
  const document = documentFor(composer);
  const selection = composerSelection(composer);
  if (selection !== null) return replaceComposerRange(composer, document, selection.start, selection.end, "");
  if (composer.cursor >= totalGraphemes(document)) return;
  replaceComposerRange(composer, document, composer.cursor, composer.cursor + 1, "");
}

export function moveComposerHorizontal(
  composer: ComposerState, direction: -1 | 1, selecting = false
): void {
  const document = documentFor(composer);
  const selection = composerSelection(composer);
  if (!selecting && selection !== null) {
    composer.anchor = null;
    setCursor(composer, document, direction < 0 ? selection.start : selection.end, false);
    return;
  }
  prepareSelection(composer, selecting);
  setCursor(composer, document, composer.cursor + direction, false);
}

export function moveComposerVertical(
  composer: ComposerState, direction: -1 | 1, selecting = false
): boolean {
  const document = documentFor(composer);
  prepareSelection(composer, selecting);
  const nextLine = Math.max(0, Math.min(document.lines.length - 1, document.cursorLine + direction));
  const preferredX = document.preferredX ?? lineWidthBefore(
    document.lines[document.cursorLine]!, document.cursorColumn
  );
  document.preferredX = preferredX;
  if (nextLine === document.cursorLine) {
    const boundary = document.lineStarts[nextLine]!
      + (direction > 0 ? document.lines[nextLine]!.count : 0);
    if (composer.cursor === boundary) return false;
    setCursor(composer, document, boundary, false);
    return true;
  }
  const nextColumn = columnAtCell(document.lines[nextLine]!, preferredX);
  setCursor(composer, document, document.lineStarts[nextLine]! + nextColumn, true);
  return true;
}

export function composerSelection(composer: ComposerState): ComposerSelection | null {
  if (composer.anchor === null || composer.anchor === composer.cursor) return null;
  return {
    start: Math.min(composer.anchor, composer.cursor),
    end: Math.max(composer.anchor, composer.cursor)
  };
}

export function composerLineSelection(composer: ComposerState, line: number): ComposerLineSelection | null {
  const selection = composerSelection(composer);
  if (selection === null) return null;
  const document = documentFor(composer);
  const start = document.lineStarts[line];
  const indexed = document.lines[line];
  if (start === undefined || indexed === undefined) return null;
  const localStart = Math.max(0, selection.start - start);
  const localEnd = Math.min(indexed.count, selection.end - start);
  const breakOffset = start + indexed.count;
  const lineBreak = indexed.breakAfter !== null
    && selection.start <= breakOffset && selection.end > breakOffset;
  return localStart < localEnd || lineBreak
    ? { start: localStart, end: localEnd, lineBreak }
    : null;
}

export function selectedComposerText(composer: ComposerState): string | null {
  const selection = composerSelection(composer);
  if (selection === null) return null;
  const document = documentFor(composer);
  return composer.text.slice(codeUnitOffset(document, selection.start), codeUnitOffset(document, selection.end));
}

export function undoComposerEdit(composer: ComposerState): boolean {
  return undoComposerEditOwner(composer) !== null;
}

export function undoComposerEditOwner(
  composer: ComposerState
): ComposerState | null {
  const history = editHistory(composer);
  const entry = history.undo.pop();
  if (entry === undefined) return null;
  history.redo.push(entry);
  restoreEdit(entry.owner, entry, true);
  return entry.owner;
}

export function redoComposerEdit(composer: ComposerState): boolean {
  return redoComposerEditOwner(composer) !== null;
}

export function redoComposerEditOwner(
  composer: ComposerState
): ComposerState | null {
  const history = editHistory(composer);
  const entry = history.redo.pop();
  if (entry === undefined) return null;
  history.undo.push(entry);
  restoreEdit(entry.owner, entry, false);
  return entry.owner;
}

/** Give multiple buffers one bounded delta journal and cross-buffer order. */
export function shareComposerEditHistory(
  composers: readonly ComposerState[]
): void {
  const history: EditHistory = {
    undo: [],
    redo: [],
    retainedCodeUnits: 0
  };
  for (const composer of composers) EDIT_HISTORIES.set(composer, history);
}

/** Discard all local undo state after an authoritative or composite edit. */
export function resetComposerEditHistory(composer: ComposerState): void {
  const history = editHistory(composer);
  history.undo = [];
  history.redo = [];
  history.retainedCodeUnits = 0;
  composer.cutConfirmation = null;
}

/** Low-level grapheme document primitives used by the editor command layer. */
export function composerLength(composer: ComposerState): number {
  return totalGraphemes(documentFor(composer));
}

export function composerCellTextAt(composer: ComposerState, offset: number): string | null {
  const document = documentFor(composer);
  return offset < 0 || offset >= totalGraphemes(document) ? null : globalCellText(document, offset);
}

export function composerLineBounds(
  composer: ComposerState, line: number
): { start: number; end: number; nextStart: number | null } {
  const document = documentFor(composer);
  const index = Math.max(0, Math.min(document.lines.length - 1, line));
  const start = document.lineStarts[index]!;
  return {
    start,
    end: start + document.lines[index]!.count,
    nextStart: document.lineStarts[index + 1] ?? null
  };
}

export function composerLineStart(composer: ComposerState, line: number): number {
  return composerLineBounds(composer, line).start;
}

export function composerLineHasBreak(composer: ComposerState, line: number): boolean {
  return composerLineBounds(composer, line).nextStart !== null;
}

export function moveComposerTo(
  composer: ComposerState,
  offset: number,
  selecting = false
): void {
  const document = documentFor(composer);
  prepareSelection(composer, selecting);
  setCursor(composer, document, offset, false);
}

export function moveComposerVerticallyTo(
  composer: ComposerState,
  offset: number,
  selecting = false
): void {
  const document = documentFor(composer);
  prepareSelection(composer, selecting);
  setCursor(composer, document, offset, true);
}

/** Retain a visual/logical horizontal goal until non-vertical motion or edits. */
export function composerPreferredX(composer: ComposerState, fallback: number): number {
  const document = documentFor(composer);
  document.preferredX ??= fallback;
  return document.preferredX;
}

export function replaceComposerTextRange(
  composer: ComposerState,
  start: number,
  end: number,
  inserted: string,
  caret?: ComposerEditCaret
): void {
  replaceComposerRange(composer, documentFor(composer), start, end, inserted, caret);
}

export function composerPosition(composer: ComposerState): ComposerPosition {
  const document = documentFor(composer);
  return { line: document.cursorLine, column: document.cursorColumn };
}

export function composerLineCount(composer: ComposerState): number {
  return documentFor(composer).lines.length;
}

export function composerLineLength(composer: ComposerState, line: number): number {
  return documentFor(composer).lines[line]?.count ?? 0;
}

export function composerLineUniformWidth(composer: ComposerState, line: number): number | null {
  return documentFor(composer).lines[line]?.uniformWidth ?? null;
}

export function composerLineSnapshot(composer: ComposerState): ComposerLineSnapshot {
  const document = documentFor(composer);
  return {
    revision: document.revision,
    change: document.lineChange,
    lineCount: document.lines.length
  };
}

export function composerLineIdentity(composer: ComposerState, line: number): object | null {
  return documentFor(composer).lines[line] ?? null;
}

export function composerLineChunks(
  composer: ComposerState,
  line: number
): readonly ComposerLineChunk[] {
  return documentFor(composer).lines[line]?.chunks ?? [];
}

export function composerLineCell(
  composer: ComposerState,
  line: number,
  column: number
): ComposerLineCell | null {
  const indexed = documentFor(composer).lines[line];
  if (indexed === undefined || column < 0 || column >= indexed.count) return null;
  const chunkIndex = chunkForColumn(indexed, column);
  const chunk = indexed.chunks[chunkIndex]!;
  return chunk.cells[column - indexed.chunkStarts[chunkIndex]!] ?? null;
}

export function composerLineSlice(
  composer: ComposerState,
  line: number,
  from: number,
  to: number
): string {
  const indexed = documentFor(composer).lines[line];
  if (indexed === undefined) return "";
  const start = Math.max(0, Math.min(indexed.count, from));
  const end = Math.max(start, Math.min(indexed.count, to));
  if (start === end) return "";
  const parts: string[] = [];
  let column = start;
  while (column < end) {
    const chunkIndex = chunkForColumn(indexed, column);
    const chunk = indexed.chunks[chunkIndex]!;
    const local = column - indexed.chunkStarts[chunkIndex]!;
    const take = Math.min(chunk.count - local, end - column);
    parts.push(chunk.cells.slice(local, local + take).map((cell) => cell.text).join(""));
    column += take;
  }
  return parts.join("");
}

function replaceComposerRange(
  composer: ComposerState,
  document: ComposerDocument,
  start: number,
  end: number,
  inserted: string,
  caret?: ComposerEditCaret
): void {
  const total = totalGraphemes(document);
  const editStart = Math.max(0, Math.min(total, start));
  const editEnd = Math.max(editStart, Math.min(total, end));
  if (editStart === editEnd && inserted.length === 0) return;
  replaceComposerCodeUnits(
    composer,
    document,
    codeUnitOffset(document, editStart),
    codeUnitOffset(document, editEnd),
    inserted,
    true,
    { start: editStart, end: editEnd },
    caret
  );
}

function replaceComposerCodeUnits(
  composer: ComposerState,
  document: ComposerDocument,
  startCodeUnit: number,
  endCodeUnit: number,
  inserted: string,
  recordHistory: boolean,
  knownGraphemeRange?: { start: number; end: number },
  caret?: ComposerEditCaret
): void {
  const editStartCodeUnit = Math.max(0, Math.min(composer.text.length, startCodeUnit));
  const editEndCodeUnit = Math.max(
    editStartCodeUnit, Math.min(composer.text.length, endCodeUnit)
  );
  if (editStartCodeUnit === editEndCodeUnit && inserted.length === 0) return;
  composer.cutConfirmation = null;
  const total = totalGraphemes(document);
  const editStart = knownGraphemeRange?.start
    ?? graphemeBoundaryAtCodeUnit(document, editStartCodeUnit, "before");
  const editEnd = knownGraphemeRange?.end
    ?? graphemeBoundaryAtCodeUnit(document, editEndCodeUnit, "after");
  // Extended emoji/ZWJ seams can absorb more than their immediate neighbour.
  // A small fixed grapheme window preserves those joins while keeping ordinary
  // edits independent of total draft size.
  const removed = composer.text.slice(editStartCodeUnit, editEndCodeUnit);
  const beforeCursor = composer.cursor;
  const beforeAnchor = composer.anchor;
  const nextText = `${composer.text.slice(0, editStartCodeUnit)}${inserted}${composer.text.slice(editEndCodeUnit)}`;
  let contextStart = Math.max(0, editStart - EDIT_CONTEXT);
  let contextEnd = Math.min(total, editEnd + EDIT_CONTEXT);
  let replacementCells: ComposerLineCell[] = [];
  let cursorWithinReplacement = 0;
  let seamProbes = 0;
  for (;;) {
    const contextStartCodeUnit = codeUnitOffset(document, contextStart);
    const contextEndCodeUnit = codeUnitOffset(document, contextEnd);
    const context = composer.text.slice(contextStartCodeUnit, contextEndCodeUnit);
    const prefixLength = editStartCodeUnit - contextStartCodeUnit;
    const replacement = `${context.slice(0, prefixLength)}${inserted}${context.slice(editEndCodeUnit - contextStartCodeUnit)}`;
    replacementCells = graphemeCells(replacement).map(({ text, width }) => ({ text, width }));
    cursorWithinReplacement = graphemeOffsetAfter(replacementCells, prefixLength + inserted.length);
    if (seamsStable(document, contextStart, contextEnd, replacementCells)) break;
    seamProbes += 1;
    // Regional-Indicator parity and similar unbounded grapheme runs can move
    // every later seam. Keep local repair bounded, then rebuild once so the
    // pathological path remains linear instead of widening quadratically.
    if (seamProbes >= MAX_SEAM_PROBES) {
      rebuildComposer(composer, nextText, editStartCodeUnit + inserted.length);
      // Match the local-splice path: clear the pre-edit selection before any
      // caller caret, so ordinary selection replaces do not leave a stale anchor.
      composer.anchor = null;
      applyEditCaret(composer, documentFor(composer), caret);
      if (recordHistory) {
        recordEdit(composer, {
          startCodeUnit: editStartCodeUnit, removed, inserted, beforeCursor, beforeAnchor,
          afterCursor: composer.cursor, afterAnchor: composer.anchor
        });
      }
      return;
    }
    const widerStart = Math.max(0, contextStart - EDIT_CONTEXT);
    const widerEnd = Math.min(total, contextEnd + EDIT_CONTEXT);
    if (widerStart === contextStart && widerEnd === contextEnd) break;
    contextStart = widerStart;
    contextEnd = widerEnd;
  }

  const lineChange = spliceDocument(document, contextStart, contextEnd, replacementCells);
  composer.text = nextText;
  document.sourceText = composer.text;
  const baseRevision = document.revision;
  document.revision += 1;
  document.lineChange = {
    baseRevision,
    revision: document.revision,
    ...lineChange,
    full: false
  };
  document.preferredX = null;
  setCursor(composer, document, contextStart + cursorWithinReplacement, false);
  composer.anchor = null;
  applyEditCaret(composer, document, caret);
  if (recordHistory) {
    recordEdit(composer, {
      startCodeUnit: editStartCodeUnit, removed, inserted, beforeCursor, beforeAnchor,
      afterCursor: composer.cursor, afterAnchor: composer.anchor
    });
  }
}

/** Apply a caller-chosen final caret after a range replace, clamped to the document. */
function applyEditCaret(
  composer: ComposerState,
  document: ComposerDocument,
  caret: ComposerEditCaret | undefined
): void {
  if (caret === undefined) return;
  const total = totalGraphemes(document);
  setCursor(composer, document, Math.max(0, Math.min(total, caret.cursor)), false);
  if (caret.anchor === undefined) {
    composer.anchor = null;
    return;
  }
  composer.anchor = caret.anchor === null
    ? null
    : Math.max(0, Math.min(total, caret.anchor));
}

function prepareSelection(composer: ComposerState, selecting: boolean): void {
  if (selecting) composer.anchor ??= composer.cursor;
  else composer.anchor = null;
}

function editHistory(composer: ComposerState): EditHistory {
  let history = EDIT_HISTORIES.get(composer);
  if (history === undefined) {
    history = { undo: [], redo: [], retainedCodeUnits: 0 };
    EDIT_HISTORIES.set(composer, history);
  }
  return history;
}

function recordEdit(
  composer: ComposerState,
  entry: EditEntry
): void {
  const history = editHistory(composer);
  history.retainedCodeUnits -= history.redo.reduce(
    (sum, candidate) => sum + retainedCodeUnits(candidate), 0
  );
  history.redo = [];
  history.undo.push({ ...entry, owner: composer });
  history.retainedCodeUnits += retainedCodeUnits(entry);
  while (history.undo.length > MAX_HISTORY_ENTRIES
    || history.retainedCodeUnits > MAX_HISTORY_CODE_UNITS) {
    const evicted = history.undo.shift();
    if (evicted === undefined) break;
    history.retainedCodeUnits -= retainedCodeUnits(evicted);
  }
}

function retainedCodeUnits(entry: EditEntry): number {
  return entry.removed.length + entry.inserted.length;
}

function restoreEdit(composer: ComposerState, entry: EditEntry, undo: boolean): void {
  const removedLength = undo ? entry.inserted.length : entry.removed.length;
  const inserted = undo ? entry.removed : entry.inserted;
  const document = documentFor(composer);
  replaceComposerCodeUnits(
    composer,
    document,
    entry.startCodeUnit,
    entry.startCodeUnit + removedLength,
    inserted,
    false
  );
  const restored = documentFor(composer);
  setCursor(composer, restored, undo ? entry.beforeCursor : entry.afterCursor, false);
  composer.anchor = undo ? entry.beforeAnchor : entry.afterAnchor;
}

function spliceDocument(
  document: ComposerDocument,
  start: number,
  end: number,
  replacementCells: readonly ComposerLineCell[]
): { start: number; removed: number; inserted: number } {
  const first = locatePosition(document, start);
  const last = locatePosition(document, end);
  const [before] = splitLine(document.lines[first.line]!, first.column);
  const [, after] = splitLine(document.lines[last.line]!, last.column);
  const replacement = linesFromCells(replacementCells);
  replacement[0] = makeLine(joinChunks(before, replacement[0]!.chunks), replacement[0]!.breakAfter);
  const tail = replacement.length - 1;
  replacement[tail] = makeLine(
    joinChunks(replacement[tail]!.chunks, after),
    document.lines[last.line]!.breakAfter
  );
  document.lines = document.lines.slice(0, first.line)
    .concat(replacement, document.lines.slice(last.line + 1));
  rebuildStarts(document);
  return {
    start: first.line,
    removed: last.line - first.line + 1,
    inserted: replacement.length
  };
}

function buildDocument(text: string): ComposerDocument {
  const cells = graphemeCells(text).map(({ text: cellText, width }) => ({ text: cellText, width }));
  return buildDocumentFromCells(text, cells);
}

function buildDocumentFromCells(
  text: string,
  cells: readonly ComposerLineCell[]
): ComposerDocument {
  const document: ComposerDocument = {
    sourceText: text,
    lines: linesFromCells(cells),
    lineStarts: [],
    codeUnitStarts: [],
    cursorSeen: Number.NaN,
    cursorLine: 0,
    cursorColumn: 0,
    preferredX: null,
    revision: 0,
    lineChange: null
  };
  rebuildStarts(document);
  return document;
}

function rebuildComposer(composer: ComposerState, text: string, cursorCodeUnits: number): void {
  const cells = graphemeCells(text).map(({ text: cellText, width }) => ({ text: cellText, width }));
  const document = buildDocumentFromCells(text, cells);
  applyFullDocumentChange(document, DOCUMENTS.get(composer));
  composer.text = text;
  DOCUMENTS.set(composer, document);
  setCursor(composer, document, graphemeOffsetAfter(cells, cursorCodeUnits), false);
}

function documentFor(composer: ComposerState): ComposerDocument {
  let document = DOCUMENTS.get(composer);
  if (document === undefined || document.sourceText !== composer.text) {
    document = rebuildDocument(composer.text, document);
    DOCUMENTS.set(composer, document);
  }
  if (document.cursorSeen !== composer.cursor) setCursor(composer, document, composer.cursor, false);
  return document;
}

function rebuildDocument(text: string, previous: ComposerDocument | undefined): ComposerDocument {
  const document = buildDocument(text);
  applyFullDocumentChange(document, previous);
  return document;
}

function applyFullDocumentChange(
  document: ComposerDocument,
  previous: ComposerDocument | undefined
): void {
  if (previous === undefined) return;
  document.revision = previous.revision + 1;
  document.lineChange = {
    baseRevision: previous.revision,
    revision: document.revision,
    start: 0,
    removed: previous.lines.length,
    inserted: document.lines.length,
    full: true
  };
}

function linesFromCells(cells: readonly ComposerLineCell[]): IndexedLine[] {
  const lines: IndexedLine[] = [];
  let current: ComposerLineCell[] = [];
  for (const cell of cells) {
    if (isLineBreak(cell.text)) {
      lines.push(makeLine(chunksFromCells(current), cell.text));
      current = [];
    } else current.push(cell);
  }
  lines.push(makeLine(chunksFromCells(current), null));
  return lines;
}

function makeLine(chunks: readonly CellChunk[], breakAfter: string | null): IndexedLine {
  const chunkStarts: number[] = [];
  let count = 0;
  let width = 0;
  let codeUnits = 0;
  for (const chunk of chunks) {
    chunkStarts.push(count);
    count += chunk.count;
    width += chunk.width;
    codeUnits += chunk.codeUnits;
  }
  const firstWidth = chunks[0]?.uniformWidth ?? null;
  const uniformWidth = firstWidth !== null
    && chunks.every((chunk) => chunk.uniformWidth === firstWidth) ? firstWidth : null;
  return { chunks, chunkStarts, count, width, codeUnits, breakAfter, uniformWidth };
}

function chunksFromCells(cells: readonly ComposerLineCell[]): CellChunk[] {
  const chunks: CellChunk[] = [];
  for (let index = 0; index < cells.length; index += CHUNK_SIZE) {
    chunks.push(makeChunk(cells.slice(index, index + CHUNK_SIZE)));
  }
  return chunks;
}

function makeChunk(cells: readonly ComposerLineCell[]): CellChunk {
  const firstWidth = cells[0]?.width ?? null;
  return {
    cells,
    count: cells.length,
    width: cells.reduce((sum, cell) => sum + cell.width, 0),
    codeUnits: cells.reduce((sum, cell) => sum + cell.text.length, 0),
    uniformWidth: firstWidth !== null && cells.every((cell) => cell.width === firstWidth)
      ? firstWidth
      : null
  };
}

function joinChunks(...groups: ReadonlyArray<readonly CellChunk[]>): CellChunk[] {
  const joined: CellChunk[] = [];
  for (const chunk of groups.flat()) {
    const previous = joined.at(-1);
    if (previous !== undefined && previous.count + chunk.count <= CHUNK_SIZE) {
      joined[joined.length - 1] = makeChunk([...previous.cells, ...chunk.cells]);
    } else if (chunk.count > 0) joined.push(chunk);
  }
  return joined;
}

function splitLine(line: IndexedLine, column: number): [CellChunk[], CellChunk[]] {
  const at = Math.max(0, Math.min(line.count, column));
  if (at === 0) return [[], [...line.chunks]];
  if (at === line.count) return [[...line.chunks], []];
  const chunkIndex = chunkForColumn(line, at);
  const local = at - line.chunkStarts[chunkIndex]!;
  const chunk = line.chunks[chunkIndex]!;
  return [
    [...line.chunks.slice(0, chunkIndex), ...chunksFromCells(chunk.cells.slice(0, local))],
    [...chunksFromCells(chunk.cells.slice(local)), ...line.chunks.slice(chunkIndex + 1)]
  ];
}

function rebuildStarts(document: ComposerDocument): void {
  document.lineStarts = [];
  document.codeUnitStarts = [];
  let grapheme = 0;
  let codeUnit = 0;
  for (const line of document.lines) {
    document.lineStarts.push(grapheme);
    document.codeUnitStarts.push(codeUnit);
    grapheme += line.count + (line.breakAfter === null ? 0 : 1);
    codeUnit += line.codeUnits + (line.breakAfter?.length ?? 0);
  }
}

function setCursor(
  composer: ComposerState,
  document: ComposerDocument,
  cursor: number,
  preservePreferredX: boolean
): void {
  const clamped = Math.max(0, Math.min(totalGraphemes(document), cursor));
  const position = locatePosition(document, clamped);
  composer.cursor = clamped;
  document.cursorSeen = clamped;
  document.cursorLine = position.line;
  document.cursorColumn = position.column;
  if (!preservePreferredX) document.preferredX = null;
}

function locatePosition(document: ComposerDocument, cursor: number): ComposerPosition {
  let low = 0;
  let high = document.lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (document.lineStarts[middle]! <= cursor) low = middle;
    else high = middle - 1;
  }
  const line = Math.max(0, low);
  return {
    line,
    column: Math.max(0, Math.min(document.lines[line]!.count, cursor - document.lineStarts[line]!))
  };
}

function codeUnitOffset(document: ComposerDocument, cursor: number): number {
  const position = locatePosition(document, cursor);
  return document.codeUnitStarts[position.line]!
    + lineCodeUnitsBefore(document.lines[position.line]!, position.column);
}

/** Map an arbitrary UTF-16 offset to the surrounding grapheme boundary.
 * History edits may bisect a grapheme that absorbed inserted ZWJ/mark text. */
function graphemeBoundaryAtCodeUnit(
  document: ComposerDocument,
  offset: number,
  side: "before" | "after"
): number {
  const bounded = Math.max(0, Math.min(document.sourceText.length, offset));
  let low = 0;
  let high = document.codeUnitStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (document.codeUnitStarts[middle]! <= bounded) low = middle;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, low);
  const line = document.lines[lineIndex]!;
  const lineStart = document.lineStarts[lineIndex]!;
  const local = bounded - document.codeUnitStarts[lineIndex]!;
  let consumed = 0;
  let column = 0;
  for (const chunk of line.chunks) {
    for (const cell of chunk.cells) {
      if (local === consumed) return lineStart + column;
      const next = consumed + cell.text.length;
      if (local < next) return lineStart + column + (side === "after" ? 1 : 0);
      consumed = next;
      column += 1;
    }
  }
  if (local === line.codeUnits) return lineStart + line.count;
  const breakEnd = line.codeUnits + (line.breakAfter?.length ?? 0);
  if (local < breakEnd) return lineStart + line.count + (side === "after" ? 1 : 0);
  return document.lineStarts[lineIndex + 1] ?? totalGraphemes(document);
}

function lineCodeUnitsBefore(line: IndexedLine, column: number): number {
  const at = Math.max(0, Math.min(line.count, column));
  let total = 0;
  for (const [index, chunk] of line.chunks.entries()) {
    const start = line.chunkStarts[index]!;
    if (start >= at) break;
    const take = Math.min(chunk.count, at - start);
    if (take === chunk.count) total += chunk.codeUnits;
    else total += chunk.cells.slice(0, take).reduce((sum, cell) => sum + cell.text.length, 0);
  }
  return total;
}

function lineWidthBefore(line: IndexedLine, column: number): number {
  const at = Math.max(0, Math.min(line.count, column));
  let total = 0;
  for (const [index, chunk] of line.chunks.entries()) {
    const start = line.chunkStarts[index]!;
    if (start >= at) break;
    const take = Math.min(chunk.count, at - start);
    if (take === chunk.count) total += chunk.width;
    else total += chunk.cells.slice(0, take).reduce((sum, cell) => sum + cell.width, 0);
  }
  return total;
}

function columnAtCell(line: IndexedLine, wanted: number): number {
  if (wanted <= 0) return 0;
  let column = 0;
  let width = 0;
  for (const chunk of line.chunks) {
    for (const cell of chunk.cells) {
      const next = width + cell.width;
      // A preferred x inside a double-width glyph has no exact boundary.
      // Stay on its leading edge instead of jumping visually to the right.
      if (next >= wanted) return next === wanted ? column + 1 : column;
      width = next;
      column += 1;
    }
  }
  return line.count;
}

function chunkForColumn(line: IndexedLine, column: number): number {
  let low = 0;
  let high = line.chunkStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (line.chunkStarts[middle]! <= column) low = middle;
    else high = middle - 1;
  }
  return Math.max(0, low);
}

function graphemeOffsetAfter(cells: readonly ComposerLineCell[], codeUnitBoundary: number): number {
  if (codeUnitBoundary <= 0) return 0;
  let end = 0;
  for (const [index, cell] of cells.entries()) {
    end += cell.text.length;
    if (end >= codeUnitBoundary) return index + 1;
  }
  return cells.length;
}

function seamsStable(
  document: ComposerDocument,
  contextStart: number,
  contextEnd: number,
  replacement: readonly ComposerLineCell[]
): boolean {
  const left = contextStart > 0 ? globalCellText(document, contextStart - 1) : null;
  const right = contextEnd < totalGraphemes(document) ? globalCellText(document, contextEnd) : null;
  if (replacement.length === 0) return segmentedAs([left, right]);
  return segmentedAs([left, replacement[0]!.text])
    && segmentedAs([replacement.at(-1)!.text, right]);
}

function segmentedAs(parts: readonly (string | null)[]): boolean {
  const expected = parts.filter((part): part is string => part !== null);
  if (expected.length <= 1) return true;
  const actual = graphemeCells(expected.join("")).map((cell) => cell.text);
  return actual.length === expected.length && actual.every((cell, index) => cell === expected[index]);
}

function globalCellText(document: ComposerDocument, offset: number): string | null {
  const position = locatePosition(document, offset);
  const line = document.lines[position.line]!;
  if (position.column === line.count) return line.breakAfter;
  const chunkIndex = chunkForColumn(line, position.column);
  const chunk = line.chunks[chunkIndex];
  const local = position.column - line.chunkStarts[chunkIndex]!;
  return chunk?.cells[local]?.text ?? null;
}

function totalGraphemes(document: ComposerDocument): number {
  const last = document.lines.length - 1;
  return document.lineStarts[last]! + document.lines[last]!.count;
}

function isLineBreak(text: string): boolean {
  return text === "\n" || text === "\r\n" || text === "\r";
}
