import { normalizeAuthorBrief } from "../shared/author-brief.js";
import type { Story } from "../shared/types.js";

/** Store one canonical Author Brief value. */
export function setAuthorBrief(story: Story, brief: string): void {
  const normalized = normalizeAuthorBrief(brief);
  if (normalized === null) {
    delete story.authorBrief;
    return;
  }
  story.authorBrief = normalized;
}
