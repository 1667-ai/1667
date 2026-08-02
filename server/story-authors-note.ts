import { normalizeAuthorsNote, normalizeAuthorsNoteDepth } from "../shared/authors-note.js";
import type { Story } from "../shared/types.js";

/** The two fields one Author's Note write owns. */
type AuthorsNoteFields = Pick<Story, "authorsNote" | "authorsNoteDepth">;

/** Store one canonical Author's Note value, with its optional depth. An
 *  absent `depth` leaves the stored depth unchanged. Clearing the note
 *  clears the depth with it — a depth with no note means nothing. */
export function setAuthorsNote(story: AuthorsNoteFields, note: string, depth?: number): void {
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

/** Whether this exact write would leave the story as it already is. Derived
 *  from the writer rather than restated, so the unchanged short circuit and
 *  the recovery predicate cannot disagree about what a write produces. A
 *  cleared note that dropped a non-default depth is the case a restatement
 *  gets wrong: no reachable story keeps that depth once the note is gone. */
export function authorsNoteApplied(
  story: AuthorsNoteFields,
  note: string,
  depth?: number
): boolean {
  const probe: AuthorsNoteFields = {
    authorsNote: story.authorsNote,
    authorsNoteDepth: story.authorsNoteDepth
  };
  setAuthorsNote(probe, note, depth);
  return probe.authorsNote === story.authorsNote
    && probe.authorsNoteDepth === story.authorsNoteDepth;
}
