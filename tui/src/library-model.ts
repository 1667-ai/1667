import { formatAge } from "../../shared/story-model.js";
import type { StorySummary } from "../../shared/types.js";
import { fuzzyFilter } from "./fuzzy.js";

export interface LibraryTotals { stories: number; words: number; parts: number; lines: number }

export function libraryRows(stories: readonly StorySummary[], query: string): StorySummary[] {
  return fuzzyFilter(stories, query, (story) => story.title);
}

interface FilteredLibraryState {
  stories: readonly StorySummary[];
  query: string;
  cursor: number;
}

/** Update a live query without transferring selection to another story. */
export function setLibraryQuery(
  overlay: FilteredLibraryState,
  query: string
): void {
  const previousRows = libraryRows(overlay.stories, overlay.query);
  const selectedId = previousRows[
    boundedLibraryCursor(overlay.cursor, previousRows.length)
  ]?.id ?? null;
  overlay.query = query;
  const rows = libraryRows(overlay.stories, query);
  const retained = selectedId === null
    ? -1
    : rows.findIndex((story) => story.id === selectedId);
  overlay.cursor = retained >= 0 ? retained : boundedLibraryCursor(0, rows.length);
}

export function boundedLibraryCursor(cursor: number, length: number): number {
  return length === 0 ? 0 : Math.max(0, Math.min(cursor, length - 1));
}

export function libraryTotals(stories: readonly StorySummary[]): LibraryTotals {
  return stories.reduce((total, story) => ({
    stories: total.stories + 1,
    words: total.words + story.words,
    parts: total.parts + story.partCount,
    lines: total.lines + story.lineCount
  }), { stories: 0, words: 0, parts: 0, lines: 0 });
}

export function libraryAge(updatedAt: string, now = Date.now()): string {
  return formatAge(updatedAt, now).toLocaleLowerCase();
}

export function typedTitleMatches(expected: string, entered: string): boolean {
  return entered === expected;
}
