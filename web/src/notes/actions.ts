import {
  MAX_AUTHORS_NOTE_CHARS,
  clampAuthorsNoteDepth
} from "../../../shared/authors-note.js";
import { MAX_AUTHOR_BRIEF_CHARS } from "../../../shared/author-brief.js";
import type { StoryPayload } from "../../../shared/types.js";
import { unicodeScalarLength } from "../../../shared/unicode.js";
import { retryWhenBusy } from "../app/busy-retry.js";
import { runBusyToast } from "../app/run-lock.js";
import type { AppState } from "../app/state.js";
import { failureToast, runStoryMutation } from "../app/story-mutation.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast } from "../app/toasts.js";
import type { StoryActions } from "../story/actions.js";
import { NOT_CONNECTED_TOAST, storyChangeRefusal } from "../story/story-policy.js";
import { downloadTextFile, exportFileBase } from "./export-file.js";
import {
  noteDraftDirty,
  noteDraftKey,
  noteDraftOf,
  noteFieldLabel,
  storedNote,
  type NoteDraft,
  type NoteField,
  type NoteTarget,
  type NotesState
} from "./state.js";

export interface NotesActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload">;
}

export interface NotesActions {
  /** `n` and the palette: opens the editor for the open story's note or brief. */
  open(field: NoteField): void;
  /** Closes the dialog; the draft stays. */
  close(): void;
  /** Closes the dialog and drops the draft. */
  discard(): void;
  setText(text: string): void;
  setDepth(depth: number): void;
  save(): Promise<void>;
  /** The palette's "autoname story". */
  autoname(): Promise<void>;
  /** The palette's "export markdown": a download. */
  exportMarkdown(): Promise<void>;
}

export const NOTE_TOO_LONG_TOAST = `Author's Note must contain at most ${MAX_AUTHORS_NOTE_CHARS.toLocaleString("en-US")} Unicode scalar values.`;
export const BRIEF_TOO_LONG_TOAST = `Author Brief must contain at most ${MAX_AUTHOR_BRIEF_CHARS.toLocaleString("en-US")} Unicode scalar values.`;

/** How many characters a field may hold, and what to say when it is too long. */
export function noteLimit(field: NoteField): { readonly max: number; readonly toast: string } {
  return field === "note"
    ? { max: MAX_AUTHORS_NOTE_CHARS, toast: NOTE_TOO_LONG_TOAST }
    : { max: MAX_AUTHOR_BRIEF_CHARS, toast: BRIEF_TOO_LONG_TOAST };
}

type Loaded = { readonly storyId: string; readonly payload: StoryPayload };

function loadedStory(state: AppState): Loaded | null {
  if (state.route.kind !== "story" || state.route.map === true || state.story.kind !== "loaded") return null;
  return state.story.payload.id === state.route.id ? { storyId: state.route.id, payload: state.story.payload } : null;
}

function savedToast(field: NoteField, text: string): string {
  const empty = text.trim().length === 0;
  if (field === "note") return empty ? "Author's Note cleared" : "Author's Note saved";
  return empty ? "Author Brief cleared" : "Author Brief saved";
}

export function createNotesActions(store: Store<AppState>, deps: NotesActionDependencies): NotesActions {
  const write = (update: (notes: NotesState) => NotesState): void =>
    store.set((state) => {
      const notes = update(state.notes);
      return notes === state.notes ? state : { ...state, notes };
    });

  const withDraft = (change: (draft: NoteDraft) => NoteDraft): void => {
    const state = store.get();
    const open = state.notes.open;
    const story = loadedStory(state);
    if (open === null || story === null || story.storyId !== open.storyId) return;
    const next = change(noteDraftOf(state.notes, story.payload, open));
    const key = noteDraftKey(open);
    write((notes) => {
      if (!noteDraftDirty(next)) {
        const { [key]: _gone, ...rest } = notes.drafts;
        return { ...notes, drafts: rest };
      }
      return { ...notes, drafts: { ...notes.drafts, [key]: next } };
    });
  };

  const dropDraft = (target: NoteTarget): void =>
    write((notes) => {
      const { [noteDraftKey(target)]: _gone, ...drafts } = notes.drafts;
      const stillOpen = notes.open !== null && noteDraftKey(notes.open) === noteDraftKey(target);
      return { ...notes, drafts, open: stillOpen ? null : notes.open };
    });

  async function save(): Promise<void> {
    const state = store.get();
    const open = state.notes.open;
    const story = loadedStory(state);
    if (open === null || story === null || story.storyId !== open.storyId || state.notes.busy) return;
    const { storyId, payload } = story;
    const draft = noteDraftOf(state.notes, payload, open);
    if (!noteDraftDirty(draft)) {
      dropDraft(open);
      return;
    }
    const limit = noteLimit(open.field);
    if (unicodeScalarLength(draft.text, limit.max) > limit.max) {
      pushToast(store, limit.toast);
      return;
    }
    const refusal = storyChangeRefusal(state, storyId);
    if (refusal !== null) {
      pushToast(store, `${refusal} Draft kept.`);
      return;
    }
    if (state.connection.kind !== "connected") return;
    const api = state.connection.api;
    const { field } = open;
    const { text } = draft;
    const depth = clampAuthorsNoteDepth(draft.depth);
    write((notes) => ({ ...notes, busy: true }));
    const outcome = await runStoryMutation(
      api,
      storyId,
      async () => ({
        payload: field === "note"
          ? await api.setAuthorsNote(storyId, text, depth)
          : await api.setAuthorBrief(storyId, text)
      }),
      (reloaded) => {
        const held = storedNote(reloaded, field);
        const empty = text.trim().length === 0;
        const sameText = held.text === (empty ? "" : text);
        return sameText && (field === "brief" || empty || held.depth === depth) ? {} : null;
      }
    );
    write((notes) => ({ ...notes, busy: false }));
    if (outcome.kind !== "saved") {
      if (outcome.kind !== "unresolved" && outcome.payload !== null) {
        deps.story.adoptPayload(storyId, outcome.payload);
        // The draft now differs from the reloaded story, not from the one it began on.
        const held = storedNote(outcome.payload, field);
        write((notes) => {
          const key = noteDraftKey(open);
          const current = notes.drafts[key];
          if (current === undefined) return notes;
          return { ...notes, drafts: { ...notes.drafts, [key]: { ...current, baseText: held.text, baseDepth: held.depth } } };
        });
      }
      pushToast(store, failureToast(outcome, `Saving the ${noteFieldLabel(field)}`, " Draft kept."));
      return;
    }
    const message = savedToast(field, text);
    deps.story.adoptPayload(storyId, outcome.payload, { announcement: message });
    pushToast(store, message);
    dropDraft(open);
  }

  async function autoname(): Promise<void> {
    const state = store.get();
    const story = loadedStory(state);
    if (story === null) return;
    if (state.connection.kind !== "connected") {
      pushToast(store, NOT_CONNECTED_TOAST);
      return;
    }
    const busy = runBusyToast(state, story.storyId);
    if (busy !== null) {
      pushToast(store, busy);
      return;
    }
    const api = state.connection.api;
    const { storyId } = story;
    const before = story.payload.title;
    write((notes) => ({ ...notes, naming: { storyId, storyTitle: before } }));
    pushToast(store, "Naming the story…");
    const outcome = await runStoryMutation(
      api,
      storyId,
      async () => ({ payload: await api.autonameStory(storyId) }),
      (reloaded) => (reloaded.title !== before ? {} : null)
    );
    write((notes) => ({ ...notes, naming: null }));
    if (outcome.kind !== "saved") {
      if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(storyId, outcome.payload);
      pushToast(store, failureToast(outcome, "Naming the story"));
      return;
    }
    const message = `Story named ${outcome.payload.title}`;
    deps.story.adoptPayload(storyId, outcome.payload, { announcement: message });
    pushToast(store, message);
  }

  async function exportMarkdown(): Promise<void> {
    const state = store.get();
    const story = loadedStory(state);
    if (story === null) return;
    if (state.connection.kind !== "connected") {
      pushToast(store, NOT_CONNECTED_TOAST);
      return;
    }
    const api = state.connection.api;
    const fileName = `${exportFileBase(story.payload.title)}.md`;
    try {
      const exported = await retryWhenBusy(() => api.exportMarkdown(story.storyId));
      downloadTextFile(fileName, exported.markdown);
      pushToast(
        store,
        exported.fidelity.length === 0
          ? `Exported ${fileName}`
          : `Exported ${fileName} · ${exported.fidelity.join("; ")}`
      );
    } catch (error) {
      pushToast(store, `Export failed: ${errorMessage(error)}`);
    }
  }

  return {
    open: (field) => {
      const story = loadedStory(store.get());
      if (story === null) return;
      write((notes) => ({ ...notes, open: { storyId: story.storyId, field } }));
    },
    close: () => write((notes) => (notes.open === null ? notes : { ...notes, open: null })),
    discard: () => {
      const open = store.get().notes.open;
      if (open !== null) dropDraft(open);
    },
    setText: (text) => withDraft((draft) => ({ ...draft, text })),
    setDepth: (depth) => withDraft((draft) => ({ ...draft, depth: clampAuthorsNoteDepth(depth) })),
    save,
    autoname,
    exportMarkdown
  };
}
