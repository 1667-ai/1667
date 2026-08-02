import { normalizeAuthorsNote, normalizeAuthorsNoteDepth } from "../shared/authors-note.js";
import type { Story } from "../shared/types.js";

/** Store one canonical Author's Note value, with its optional depth. An
 *  absent `depth` leaves the stored depth unchanged. Clearing the note
 *  clears the depth with it — a depth with no note means nothing. */
export function setAuthorsNote(story: Story, note: string, depth?: number): void {
  const normalized = normalizeAuthorsNote(note);
  if (normalized === null) {
    delete story.authorsNote;
    delete story.authorsNoteDepth;
    return;
  }
  story.authorsNote = normalized;
  if (depth === undefined) return;
  const normalizedDepth = normalizeAuthorsNoteDepth(depth);
  if (normalizedDepth === null) delete story.authorsNoteDepth;
  else story.authorsNoteDepth = normalizedDepth;
}
