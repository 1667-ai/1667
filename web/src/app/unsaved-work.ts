import { composeDraftOf, type ComposeState } from "../compose/state.js";
import { editorCopyText, editorDirty, type EditorState } from "../editor/state.js";
import { changedPromptText, isDirty } from "../settings/model.js";
import type { SettingsState } from "../settings/state.js";
import { factEditorCopyText, factEditorDirty, type FactsState } from "../facts/state.js";

/**
 * Writing that lives only in this page: a changed editor, a changed fact editor, changed settings, and any composer
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
  settings: SettingsState
): UnsavedItem[] {
  const items: UnsavedItem[] = [];
  if (editor !== null && editorDirty(editor)) {
    items.push({ id: "editor", label: "Unsaved edit", text: editorCopyText(editor) });
  }
  if (facts.editor !== null && factEditorDirty(facts.editor)) {
    items.push({ id: "fact", label: "Unsaved fact", text: factEditorCopyText(facts.editor) });
  }
  // The Copy text is the changed prompt text only. A key is write-only: it is
  // in the draft's memory, and nowhere that could be copied.
  if (settings.kind === "loaded" && isDirty(settings)) {
    items.push({ id: "settings", label: "Unsaved settings", text: changedPromptText(settings) });
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
  return items;
}
