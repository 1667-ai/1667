import { resolveAuthorsNoteDepth } from "../../../shared/authors-note.js";
import type { StoryPayload } from "../../../shared/types.js";

/**
 * The Author's Note and author brief editors (#409 step 10b), and the story
 * naming run. The editors are the TUI's two story text fields: the note has a
 * depth, the brief is plain text. A draft lives here, per (story, field), so
 * closing the dialog, a refused save or a conflict never loses it.
 */
export type NoteField = "note" | "brief";

export interface NoteDraft {
  readonly text: string;
  readonly depth: number;
  /** What the story held when the draft began: the draft is a change only while it differs. */
  readonly baseText: string;
  readonly baseDepth: number;
}

export interface NoteTarget {
  readonly storyId: string;
  readonly field: NoteField;
}

/** The story that is being named: a provider call, so it holds the story like a run. */
export interface NamingRun {
  readonly storyId: string;
  readonly storyTitle: string;
}

export interface NotesState {
  readonly open: NoteTarget | null;
  readonly drafts: Readonly<Record<string, NoteDraft>>;
  /** A save is in flight. */
  readonly busy: boolean;
  readonly naming: NamingRun | null;
}

export function initialNotesState(): NotesState {
  return { open: null, drafts: {}, busy: false, naming: null };
}

export function noteDraftKey(target: NoteTarget): string {
  return `${target.storyId}:${target.field}`;
}

/** The story's own value for a field. */
export function storedNote(payload: StoryPayload, field: NoteField): { readonly text: string; readonly depth: number } {
  return field === "note"
    ? { text: payload.authorsNote ?? "", depth: resolveAuthorsNoteDepth(payload.authorsNoteDepth) }
    : { text: payload.authorBrief ?? "", depth: 1 };
}

export function noteDraftDirty(draft: NoteDraft): boolean {
  return draft.text !== draft.baseText || draft.depth !== draft.baseDepth;
}

/** What the dialog shows: the writer's draft, or else what the story holds. */
export function noteDraftOf(state: NotesState, payload: StoryPayload, target: NoteTarget): NoteDraft {
  const draft = state.drafts[noteDraftKey(target)];
  if (draft !== undefined) return draft;
  const stored = storedNote(payload, target.field);
  return { text: stored.text, depth: stored.depth, baseText: stored.text, baseDepth: stored.depth };
}

export function noteFieldLabel(field: NoteField): string {
  return field === "note" ? "Author's Note" : "Author brief";
}
