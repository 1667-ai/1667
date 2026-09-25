import type { StorySummary } from "../../../shared/types.js";

/** Moved out of `library/Sidebar.tsx` (review fix B6): case-insensitive
 * title substring match, sorted by `updatedAt` desc. The Sidebar's search
 * box and story list share this one function, so what you typed and what's
 * shown never drift apart. */
export function filterAndSort(
  stories: readonly StorySummary[] | null,
  query: string
): readonly StorySummary[] {
  if (stories === null) return [];
  const needle = query.trim().toLowerCase();
  const matching = needle.length === 0
    ? stories
    : stories.filter((summary) => summary.title.toLowerCase().includes(needle));
  return [...matching].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
