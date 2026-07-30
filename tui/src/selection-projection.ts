import { graphemeCells, isPrintableAscii } from "./cell-width.js";
import type { FrameLine } from "./screens/story/frame.js";

interface SelectionCell {
  start: number;
  end: number;
  sourceId?: string;
  editable?: false;
}

/** Sparse page-buffer cell map. OpenTUI TextBufferView selections use display
 * cells (for example, `A界` ends at 3), plus one offset per newline. Wide
 * graphemes therefore deliberately repeat their source range across cells. */
export type ComposerSelectionProjection = ReadonlyArray<SelectionCell | null>;

export interface StorySelectionCell extends SelectionCell {
  key: string;
  text: string;
}

export type StorySelectionProjection = ReadonlyArray<StorySelectionCell | null>;

export interface StorySelectionSpan {
  key: string;
  text: string;
  start: number;
  end: number;
}

export interface ProjectedStorySelection {
  text: string;
  spans: StorySelectionSpan[];
}

export type ProjectedComposerSelection =
  | (SelectionCell & { kind: "range" })
  | { kind: "uneditable"; sourceId?: string }
  | { kind: "mixed" };

export function buildComposerSelectionProjection(
  lines: readonly FrameLine[],
  width: number
): ComposerSelectionProjection | null {
  const stride = width + 1;
  const cells: Array<SelectionCell | null> = Array(
    Math.max(0, lines.length * stride - 1)
  ).fill(null);
  let mapped = false;
  for (const [row, line] of lines.entries()) {
    let column = 0;
    for (const part of line) {
      let composerOffset = part.composerStart;
      const uneditable = composerOffset === undefined
        && part.composerSource?.editable === false;
      if (isPrintableAscii(part.text)) {
        const length = Math.min(part.text.length, width - column);
        if (composerOffset !== undefined || uneditable) {
          for (let offset = 0; offset < length; offset += 1) {
            cells[row * stride + column + offset] = uneditable ? {
              start: 0,
              end: 0,
              sourceId: part.composerSource?.id,
              editable: false
            } : {
              start: composerOffset! + offset,
              end: composerOffset! + offset + 1,
              ...(part.composerSource === undefined
                ? {}
                : { sourceId: part.composerSource.id })
            };
          }
          mapped ||= length > 0;
        }
        column += length;
        if (column >= width) break;
        continue;
      }
      for (const cell of graphemeCells(part.text)) {
        if (composerOffset !== undefined || uneditable) {
          const range: SelectionCell = uneditable ? {
            start: 0,
            end: 0,
            sourceId: part.composerSource?.id,
            editable: false
          } : {
            start: composerOffset!,
            end: composerOffset! + 1,
            ...(part.composerSource === undefined
              ? {}
              : { sourceId: part.composerSource.id })
          };
          for (let inside = 0; inside < cell.width && column + inside < width; inside += 1) {
            cells[row * stride + column + inside] = range;
            mapped = true;
          }
          if (composerOffset !== undefined) composerOffset += 1;
        }
        column += cell.width;
        if (column >= width) break;
      }
      if (column >= width) break;
    }
  }
  return mapped ? cells : null;
}

export function buildStorySelectionProjection(
  lines: readonly FrameLine[],
  width: number
): StorySelectionProjection | null {
  const stride = width + 1;
  const cells: Array<StorySelectionCell | null> = Array(
    Math.max(0, lines.length * stride - 1)
  ).fill(null);
  let mapped = false;
  for (const [row, line] of lines.entries()) {
    let column = 0;
    for (const part of line) {
      const source = part.storySource;
      if (isPrintableAscii(part.text)) {
        const length = Math.min(part.text.length, width - column);
        if (source !== undefined) {
          for (let offset = 0; offset < length; offset += 1) {
            const start = source.start + offset;
            cells[row * stride + column + offset] = {
              key: source.key,
              text: source.text,
              start,
              end: start + 1
            };
          }
          mapped ||= length > 0;
        }
        column += length;
        if (column >= width) break;
        continue;
      }
      for (const cell of graphemeCells(part.text)) {
        if (source !== undefined) {
          const start = source.start + cell.index;
          const range = { key: source.key, text: source.text, start, end: start + cell.text.length };
          for (let inside = 0; inside < cell.width && column + inside < width; inside += 1) {
            cells[row * stride + column + inside] = range;
            mapped = true;
          }
        }
        column += cell.width;
        if (column >= width) break;
      }
      if (column >= width) break;
    }
  }
  return mapped ? cells : null;
}

export function composerRangeFromProjection(
  projection: ComposerSelectionProjection,
  displayStart: number,
  displayEnd: number
): ProjectedComposerSelection | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let sourceId: SelectionCell["sourceId"];
  let hasSource = false;
  let uneditable = false;
  const from = Math.max(0, Math.min(projection.length, displayStart));
  const to = Math.max(from, Math.min(projection.length, displayEnd));
  for (let index = from; index < to; index += 1) {
    const cell = projection[index];
    if (cell === null || cell === undefined) continue;
    if (!hasSource) {
      sourceId = cell.sourceId;
      hasSource = true;
    } else if (cell.sourceId !== sourceId) {
      return { kind: "mixed" };
    }
    uneditable ||= cell.editable === false;
    start = Math.min(start, cell.start);
    end = Math.max(end, cell.end);
  }
  if (hasSource && uneditable) {
    return {
      kind: "uneditable",
      ...(sourceId === undefined ? {} : { sourceId })
    };
  }
  return Number.isFinite(start) && Number.isFinite(end)
    ? {
        kind: "range",
        start,
        end,
        ...(sourceId === undefined ? {} : { sourceId })
      }
    : null;
}

/** Recover raw prose/instruction text from painted cells. Layout gutter,
 * wrapping, padding, and chrome have no source entries and disappear. */
export function storyTextFromProjection(
  projection: StorySelectionProjection,
  displayStart: number,
  displayEnd: number
): string | null {
  return storySelectionFromProjection(projection, displayStart, displayEnd)?.text ?? null;
}

/** Capture both the semantic prose and its source spans. The spans let an
 * overlay repaint the selection after clearing OpenTUI's buffer selection. */
export function storySelectionFromProjection(
  projection: StorySelectionProjection,
  displayStart: number,
  displayEnd: number
): ProjectedStorySelection | null {
  const from = Math.max(0, Math.min(projection.length, displayStart));
  const to = Math.max(from, Math.min(projection.length, displayEnd));
  const spans: StorySelectionSpan[] = [];
  for (let index = from; index < to; index += 1) {
    const cell = projection[index];
    if (cell === null || cell === undefined) continue;
    const previous = spans.at(-1);
    if (previous?.key === cell.key) {
      previous.start = Math.min(previous.start, cell.start);
      previous.end = Math.max(previous.end, cell.end);
    } else {
      spans.push({ ...cell });
    }
  }
  if (spans.length === 0) return null;
  const text = spans
    .map(({ text, start, end }) => text.slice(start, end))
    .filter((text) => text.length > 0)
    .join("\n\n");
  return text.length === 0 ? null : { text, spans };
}
