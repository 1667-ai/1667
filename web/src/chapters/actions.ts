import type { RemovedChapterBreak, StoryApi } from "../../../client/api.js";
import { chapterWord } from "../../../shared/chapter-labels.js";
import { createManuscriptModel } from "../../../shared/manuscript-model.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";
import { failureToast, runStoryMutation, type StoryMutationOutcome } from "../app/story-mutation.js";
import type { Store } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import type { StoryActions } from "../story/actions.js";
import { storyChangeRefusal } from "../story/story-policy.js";
import type { ChapterRename, ChapterUndoEntry, ChaptersState } from "./state.js";

export interface ChapterActionDependencies {
  readonly story: Pick<StoryActions, "adoptPayload">;
}

export interface ChapterActions {
  /** `C`: ends the chapter after this part. The caller has asked
   * `partActionRefusal` first. Opens the new divider's rename. */
  addBreak(partId: string): Promise<void>;
  /** Opens the one inline rename. `breakId` is `null` for chapter one. */
  startRename(breakId: string | null, origin: ChapterRename["origin"]): void;
  setRenameText(text: string): void;
  cancelRename(): void;
  /** Focus left the input: an unchanged rename closes, a changed one stays. */
  blurRename(): void;
  saveRename(): Promise<void>;
  removeBreak(breakId: string): Promise<void>;
  /** `u`: takes back the last added or removed chapter break. */
  undo(): Promise<void>;
}

export const NOTHING_TO_UNDO_TOAST = "Nothing to undo. u takes back an added or removed chapter break.";

type Loaded = { readonly storyId: string; readonly payload: StoryPayload; readonly api: StoryApi };

/** The open story and the connection, or `null`. */
function openStory(state: AppState): Loaded | null {
  if (state.route.kind !== "story" || state.story.kind !== "loaded") return null;
  if (state.story.payload.id !== state.route.id || state.connection.kind !== "connected") return null;
  return { storyId: state.route.id, payload: state.story.payload, api: state.connection.api };
}

/** The stored title of the chapter a break opens (`null`: chapter one). */
export function storedChapterTitle(payload: StoryPayload, breakId: string | null): string | null {
  if (breakId === null) return payload.firstChapterTitle ?? "";
  return payload.chapterBreaks.find((candidate) => candidate.id === breakId)?.title ?? null;
}

export function createChapterActions(store: Store<AppState>, deps: ChapterActionDependencies): ChapterActions {
  const write = (update: (chapters: ChaptersState) => ChaptersState): void =>
    store.set((state) => {
      const chapters = update(state.chapters);
      return chapters === state.chapters ? state : { ...state, chapters };
    });

  const pushUndo = (storyId: string, entry: ChapterUndoEntry): void =>
    write((chapters) => ({ ...chapters, undo: { ...chapters.undo, [storyId]: [...(chapters.undo[storyId] ?? []), entry] } }));

  const popUndo = (storyId: string, entry: ChapterUndoEntry): void =>
    write((chapters) => {
      const stack = chapters.undo[storyId] ?? [];
      return stack.at(-1) === entry ? { ...chapters, undo: { ...chapters.undo, [storyId]: stack.slice(0, -1) } } : chapters;
    });

  /** One structural change at a time: a second key press while one is in
   * flight is ignored, not queued. */
  let changing = false;

  /** Adopts the reload a failed call left behind, and says what happened. */
  function settleFailure(
    storyId: string,
    outcome: Exclude<StoryMutationOutcome<object>, { kind: "saved" }>,
    what: string,
    kept = ""
  ): void {
    if (outcome.kind !== "unresolved" && outcome.payload !== null) deps.story.adoptPayload(storyId, outcome.payload);
    pushToast(store, failureToast(outcome, what, kept));
  }

  /** Runs one change that needs a connection and an unlocked story. */
  async function change<R extends object>(
    what: string,
    run: (open: Loaded) => Promise<StoryMutationOutcome<R>>,
    onSaved: (open: Loaded, outcome: Extract<StoryMutationOutcome<R>, { kind: "saved" }>) => void
  ): Promise<void> {
    const state = store.get();
    const open = openStory(state);
    if (open === null || changing) return;
    const refusal = storyChangeRefusal(state, open.storyId);
    if (refusal !== null) {
      pushToast(store, refusal);
      return;
    }
    changing = true;
    try {
      const outcome = await run(open);
      if (outcome.kind === "saved") onSaved(open, outcome);
      else settleFailure(open.storyId, outcome, what);
    } finally {
      changing = false;
    }
  }

  const clearRenameFor = (breakId: string): void =>
    write((chapters) => (chapters.rename?.breakId === breakId ? { ...chapters, rename: null } : chapters));

  return {
    addBreak: (partId) => change(
      "Ending the chapter",
      async ({ storyId, payload, api }) => {
        const known = new Set(payload.chapterBreaks.map((chapterBreak) => chapterBreak.id));
        return await runStoryMutation(
          api,
          storyId,
          () => api.createChapterBreak(storyId, partId),
          (reloaded) => {
            const created = reloaded.chapterBreaks.find((candidate) =>
              candidate.parentPartId === partId && !known.has(candidate.id));
            return created === undefined ? null : { breakId: created.id };
          }
        );
      },
      ({ storyId, payload }, { payload: next, value }) => {
        const number = createManuscriptModel(payload).parts.find((part) => part.id === partId)?.chapterNumber ?? 1;
        const announcement = `Chapter ${chapterWord(number)} ends here. The next part opens Chapter ${chapterWord(number + 1)}.`;
        deps.story.adoptPayload(storyId, next, { announcement });
        pushUndo(storyId, { kind: "added", breakId: value.breakId });
        // The new divider's title is the next thing the writer names.
        write((chapters) => ({
          ...chapters,
          rename: { storyId, breakId: value.breakId, text: "", origin: "manuscript", saving: false }
        }));
      }
    ),

    startRename: (breakId, origin) => {
      const open = openStory(store.get());
      if (open === null) return;
      const title = storedChapterTitle(open.payload, breakId);
      if (title === null) return;
      write((chapters) => {
        if (chapters.rename?.saving === true) return chapters;
        return { ...chapters, rename: { storyId: open.storyId, breakId, text: title, origin, saving: false } };
      });
    },

    setRenameText: (text) => write((chapters) => (
      chapters.rename === null || chapters.rename.saving || chapters.rename.text === text
        ? chapters
        : { ...chapters, rename: { ...chapters.rename, text } }
    )),

    cancelRename: () => write((chapters) => (
      chapters.rename === null || chapters.rename.saving ? chapters : { ...chapters, rename: null }
    )),

    blurRename: () => {
      const rename = store.get().chapters.rename;
      const open = openStory(store.get());
      if (rename === null || rename.saving || open === null) return;
      if (rename.text.trim() === storedChapterTitle(open.payload, rename.breakId)) {
        write((chapters) => (chapters.rename === rename ? { ...chapters, rename: null } : chapters));
      }
    },

    saveRename: async () => {
      const state = store.get();
      const rename = state.chapters.rename;
      const open = openStory(state);
      if (rename === null || rename.saving || open === null || open.storyId !== rename.storyId) return;
      const title = rename.text.trim();
      if (title === storedChapterTitle(open.payload, rename.breakId)) {
        write((chapters) => (chapters.rename === rename ? { ...chapters, rename: null } : chapters));
        return;
      }
      const refusal = storyChangeRefusal(state, open.storyId);
      if (refusal !== null) {
        pushToast(store, `${refusal} Draft kept.`);
        return;
      }
      const saving = { ...rename, saving: true };
      write((chapters) => ({ ...chapters, rename: saving }));
      const { storyId, api } = open;
      const outcome = await runStoryMutation(
        api,
        storyId,
        async () => ({ payload: await api.renameChapterBreak(storyId, rename.breakId, title) }),
        (reloaded) => (storedChapterTitle(reloaded, rename.breakId) === title ? {} : null)
      );
      // The text the writer typed while the call ran is theirs: only the
      // flag comes off, unless the save went through.
      const finish = (done: boolean): void => write((chapters) => {
        const current = chapters.rename;
        if (current === null || current.breakId !== rename.breakId) return chapters;
        return { ...chapters, rename: done ? null : { ...current, saving: false } };
      });
      if (outcome.kind !== "saved") {
        finish(false);
        settleFailure(storyId, outcome, "Renaming the chapter", " Draft kept.");
        return;
      }
      deps.story.adoptPayload(storyId, outcome.payload, { announcement: "Chapter renamed." });
      finish(true);
    },

    removeBreak: (breakId) => change(
      "Removing the break",
      async ({ storyId, api }) => await runStoryMutation<{ removed?: RemovedChapterBreak }>(
        api,
        storyId,
        () => api.removeChapterBreak(storyId, breakId),
        (reloaded) => (reloaded.chapterBreaks.some((candidate) => candidate.id === breakId) ? null : {})
      ),
      ({ storyId }, { payload, value, reconciled }) => {
        deps.story.adoptPayload(storyId, payload, { announcement: "Chapter break removed." });
        clearRenameFor(breakId);
        if (!reconciled && value.removed !== undefined) {
          pushUndo(storyId, { kind: "removed", breakId, removed: value.removed });
          pushToast(store, "Chapter break removed. u undoes.");
        } else {
          pushToast(store, "Removed. This one cannot be undone.");
        }
      }
    ),

    undo: async () => {
      const state = store.get();
      const open = openStory(state);
      if (open === null) return;
      const entry = state.chapters.undo[open.storyId]?.at(-1);
      if (entry === undefined) {
        pushToast(store, NOTHING_TO_UNDO_TOAST);
        return;
      }
      await change(
        "Undo",
        async ({ storyId, api }) => entry.kind === "added"
          ? await runStoryMutation(
            api,
            storyId,
            async () => ({ payload: (await api.removeChapterBreak(storyId, entry.breakId)).payload }),
            (reloaded) => (reloaded.chapterBreaks.some((candidate) => candidate.id === entry.breakId) ? null : {})
          )
          : await runStoryMutation(
            api,
            storyId,
            async () => ({ payload: await api.restoreChapterBreak(storyId, entry.breakId, entry.removed) }),
            (reloaded) => (reloaded.chapterBreaks.some((candidate) => candidate.id === entry.breakId) ? {} : null)
          ),
        ({ storyId }, { payload }) => {
          const message = entry.kind === "added" ? "Chapter break undone." : "Chapter break restored.";
          deps.story.adoptPayload(storyId, payload, { announcement: message });
          popUndo(storyId, entry);
          clearRenameFor(entry.breakId);
          pushToast(store, message);
        }
      );
    }
  };
}
