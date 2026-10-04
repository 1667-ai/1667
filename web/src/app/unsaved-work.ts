import { initialAsideState, type AsideState } from "../aside/state.js";
import { composeDraftOf, type ComposeState } from "../compose/state.js";
import { editorCopyText, editorDirty, type EditorState } from "../editor/state.js";
import { noteDraftDirty, noteFieldLabel, type NotesState } from "../notes/state.js";
import { changedPromptText, isDirty } from "../settings/model.js";
import type { SettingsState } from "../settings/state.js";
import { STORY_LIST_LABELS, type StoryListDrafts, type StoryListField } from "../settings/story-lists.js";
import { factEditorCopyText, factEditorDirty, type FactsState } from "../facts/state.js";

/**
 * Writing that lives only in this page: a changed editor, a changed fact editor, changed settings, Aside questions, and any composer
 * text that was not sent. It is lost on a reload, and unreachable behind a
 * connection screen — so the unload guard warns about it, and the connection
 * screens list it with a Copy button.
 */
export interface UnsavedItem {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export function unsavedWork(
  editor: EditorState | null,
  compose: ComposeState,
  facts: FactsState,
  notes: NotesState,
  settings: SettingsState,
  aside: AsideState = initialAsideState(),
  storyLists: StoryListDrafts = {}
): UnsavedItem[] {
  const items: UnsavedItem[] = [];
  if (editor !== null && editorDirty(editor)) {
    items.push({ id: "editor", label: "Unsaved edit", text: editorCopyText(editor) });
  }
  if (facts.editor !== null && factEditorDirty(facts.editor)) {
    items.push({ id: "fact", label: "Unsaved fact", text: factEditorCopyText(facts.editor) });
  }
  for (const [key, draft] of Object.entries(notes.drafts)) {
    if (!noteDraftDirty(draft)) continue;
    items.push({ id: `note:${key}`, label: `Unsaved ${noteFieldLabel(key.endsWith(":brief") ? "brief" : "note")}`, text: draft.text });
  }
  // The Copy text is the changed prompt text only. A key is write-only: it is
  // in the draft's memory, and nowhere that could be copied.
  if (settings.kind === "loaded" && isDirty(settings)) {
    items.push({ id: "settings", label: "Unsaved settings", text: changedPromptText(settings) });
  }
  for (const [storyId, fields] of Object.entries(storyLists)) {
    for (const [field, text] of Object.entries(fields)) {
      items.push({ id: `story-list:${storyId}:${field}`, label: `Unsaved ${STORY_LIST_LABELS[field as StoryListField].toLowerCase()} for a story`, text: text ?? "" });
    }
  }
  for (const storyId of Object.keys(compose.drafts)) {
    const draft = composeDraftOf(compose, storyId);
    if (draft.direct.trim().length > 0) {
      items.push({ id: `direct:${storyId}`, label: "Unsent direction", text: draft.direct });
    }
    if (draft.retake !== null && draft.retake.text.trim().length > 0) {
      items.push({ id: `retake:${storyId}`, label: "Unsent retake direction", text: draft.retake.text });
    }
  }
  for (const [storyId, draft] of Object.entries(aside.drafts)) {
    if (draft.trim().length > 0) items.push({ id: `aside:${storyId}`, label: "Unsent Aside question", text: draft });
  }
  for (const draft of Object.values(aside.retakes)) {
    if (draft.text.trim().length > 0) {
      items.push({ id: `aside-retake:${draft.sessionId}`, label: "Unsent Aside retake question", text: draft.text });
    }
  }
  for (const item of aside.unsaved) {
    items.push({ id: `aside-unsaved:${item.id}`, label: "Aside answer not saved", text: item.text });
  }
  // A question that is being answered is not lost: a Stop with no answer, or a
  // failure, hands it back. It is listed so a reload does not lose it quietly.
  if (aside.run !== null && aside.run.question.trim().length > 0 && aside.run.kind !== "change") {
    items.push({ id: `aside-run:${aside.run.storyId}`, label: "Aside question being answered", text: aside.run.question });
  }
  return items;
}
