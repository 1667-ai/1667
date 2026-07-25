import { truncate, visibleWidth, type FrameLine } from "./story/frame.js";

export interface ChapterColumns {
  lead: number;
  chapter: number;
  title: number;
  extent: number;
  status: number;
  marker: number;
}

export function chapterColumns(width: number, digits: number): ChapterColumns {
  const wide = width >= 83 + Math.max(0, digits - 2);
  const values = fitColumnWidths(
    [4, digits + 2, 29, wide ? 18 : 16, wide ? 24 : 22, 4],
    [4, 4, 1, 1, 4, 4],
    width,
    [2, 3, 4, 1, 0, 5]
  );
  return { lead: values[0]!, chapter: values[1]!, title: values[2]!, extent: values[3]!, status: values[4]!, marker: values[5]! };
}

export interface LibraryColumns {
  lead: number;
  title: number;
  words: number;
  structure: number;
  updated: number;
}

const LIBRARY_COLUMNS: LibraryColumns = { lead: 4, title: 36, words: 8, structure: 24, updated: 10 };
const LIBRARY_WIDE_WIDTH = Object.values(LIBRARY_COLUMNS).reduce((sum, value) => sum + value, 0);

export function libraryColumns(width: number): LibraryColumns {
  const updated = width >= LIBRARY_WIDE_WIDTH ? LIBRARY_COLUMNS.updated : 0;
  const values = fitColumnWidths(
    [LIBRARY_COLUMNS.lead, LIBRARY_COLUMNS.title, LIBRARY_COLUMNS.words, LIBRARY_COLUMNS.structure, updated],
    [4, 1, 1, 2, 0],
    width,
    [1, 3, 2, 0, 4]
  );
  return { lead: values[0]!, title: values[1]!, words: values[2]!, structure: values[3]!, updated: values[4]! };
}

export interface FactColumns { lead: number; name: number; tag: number; note: number }

export function factColumns(width: number): FactColumns {
  const values = fitColumnWidths([4, 31, 14, 42], [4, 7, 6, 1], width, [3, 1, 2, 0]);
  return { lead: values[0]!, name: values[1]!, tag: values[2]!, note: values[3]! };
}

export function cellPad(value: string, width: number): string {
  const shown = truncate(value, width);
  return `${shown}${" ".repeat(Math.max(0, width - visibleWidth(shown)))}`;
}

export function cellPadStart(value: string, width: number): string {
  const shown = truncate(value, width);
  return `${" ".repeat(Math.max(0, width - visibleWidth(shown)))}${shown}`;
}

export function boundedContent(content: FrameLine[], width: number): FrameLine[] {
  return content.map((line) => {
    const bounded: FrameLine = [];
    let remaining = width;
    for (const segment of line) {
      if (remaining <= 0) break;
      const text = truncate(segment.text, remaining);
      if (text.length > 0) bounded.push({ ...segment, text });
      remaining -= visibleWidth(text);
    }
    return bounded;
  });
}

export interface PanelRowWindow { start: number; end: number }

/** Keep the selected logical row visible when rows can expand to several
 * physical lines. Complete preceding rows fill first; trailing rows use any
 * remaining panel body. */
export function panelRowWindow(
  heights: readonly number[],
  cursor: number,
  budget: number
): PanelRowWindow {
  if (heights.length === 0) return { start: 0, end: 0 };
  const selected = Math.max(0, Math.min(heights.length - 1, cursor));
  const available = Math.max(1, budget);
  let start = selected;
  let used = Math.min(available, Math.max(1, heights[selected]!));
  while (start > 0 && used + Math.max(1, heights[start - 1]!) <= available) {
    start -= 1;
    used += Math.max(1, heights[start]!);
  }
  let end = selected + 1;
  while (end < heights.length && used + Math.max(1, heights[end]!) <= available) {
    used += Math.max(1, heights[end]!);
    end += 1;
  }
  return { start, end };
}

export function panelRange(total: number, window: PanelRowWindow): string {
  return total <= window.end - window.start ? "" : ` · ${window.start + 1}–${window.end}/${total}`;
}

function fitColumnWidths(desired: number[], minimum: number[], width: number, shrinkOrder: number[]): number[] {
  const fitted = [...desired];
  let overflow = Math.max(0, fitted.reduce((sum, value) => sum + value, 0) - width);
  for (const index of shrinkOrder) {
    const current = fitted[index]!;
    const reduction = Math.min(overflow, Math.max(0, current - minimum[index]!));
    fitted[index] = current - reduction;
    overflow -= reduction;
  }
  return fitted;
}
