import { normalizeAuthorBrief } from "../shared/author-brief.js";
import type { Story } from "../shared/types.js";

/** The field one Author Brief write owns. */
type AuthorBriefFields = Pick<Story, "authorBrief">;

/** Store one canonical Author Brief value. */
export function setAuthorBrief(story: AuthorBriefFields, brief: string): void {
  const normalized = normalizeAuthorBrief(brief);
  if (normalized === null) {
    delete story.authorBrief;
    return;
  }
  story.authorBrief = normalized;
}

/** Whether this exact write would leave the story as it already is. Derived
 *  from the writer for the reason given on `authorsNoteApplied`. */
export function authorBriefApplied(story: AuthorBriefFields, brief: string): boolean {
  const probe: AuthorBriefFields = { authorBrief: story.authorBrief };
  setAuthorBrief(probe, brief);
  return probe.authorBrief === story.authorBrief;
}
