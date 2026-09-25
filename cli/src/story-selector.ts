import type { StorySummary } from "../../shared/types.js";
import { terminalLineText as plain } from "../../shared/terminal-text.js";

/** Resolve a `--story` value that every import command accepts.
 *
 * The order is id, then exact title, then case-folded title, so a writer can
 * name a story the way they read it and still be answered exactly. */
export function selectStory(stories: readonly StorySummary[], value: string): StorySummary {
  const byId = stories.find((story) => story.id === value);
  if (byId !== undefined) return byId;

  const exactTitles = stories.filter((story) => story.title === value);
  if (exactTitles.length > 0) return oneStoryTitleMatch(value, exactTitles);

  const foldedValue = value.toLowerCase();
  const foldedTitles = stories.filter((story) => story.title.toLowerCase() === foldedValue);
  if (foldedTitles.length > 0) return oneStoryTitleMatch(value, foldedTitles);

  throw new Error(`unknown story: ${plain(value)}`);
}

function oneStoryTitleMatch(value: string, matches: readonly StorySummary[]): StorySummary {
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    `more than one story has the name "${plain(value)}"; use the story id `
      + `(${matches.map((story) => story.id).join(", ")})`
  );
}
