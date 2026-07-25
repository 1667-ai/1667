import { formatAge } from "../../shared/loom-model.js";
import type { StorySummary } from "../../shared/types.js";
import { fuzzyFilter } from "./fuzzy.js";

export interface LibraryTotals { stories: number; words: number; parts: number; lines: number }

export function libraryRows(stories: readonly StorySummary[], query: string): StorySummary[] {
  return fuzzyFilter(stories, query, (story) => story.title);
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
