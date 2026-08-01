import { normalizeAuthorsNote } from "../shared/authors-note.js";
import type { Story } from "../shared/types.js";

/** Store one canonical Author's Note value. */
export function setAuthorsNote(story: Story, note: string): void {
  const normalized = normalizeAuthorsNote(note);
  if (normalized === null) {
    delete story.authorsNote;
    return;
  }
  story.authorsNote = normalized;
}
