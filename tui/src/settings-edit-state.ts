import type {
  ComposerState
} from "./composer-model.js";
import type {
  RuntimeState,
  SettingsOverlayState,
  SettingsRowId
} from "./state.js";

export interface ActiveSettingsEdit {
  row: SettingsRowId;
  composer: ComposerState;
  initialText(): string;
  setInitialText(value: string): void;
}

/** Derive the visible Settings edit from its one canonical owner. */
export function activeSettingsEdit(
  state: Pick<RuntimeState, "mode" | "editor" | "settings">,
  overlay: SettingsOverlayState
): ActiveSettingsEdit | null {
  if (state.settings !== overlay) return null;
  if (state.mode === "SETTINGS") {
    const edit = overlay.edit;
    return edit === null ? null : {
      row: edit.row,
      composer: edit.composer,
      initialText: () => edit.initial,
      setInitialText: (value) => { edit.initial = value; }
    };
  }
  const editor = state.mode === "EDITOR" ? state.editor : null;
  return editor?.kind === "document"
    && editor.target.kind === "settings-prompt"
    && editor.target.owner === overlay
      ? {
        row: "system-prompt",
        composer: editor.composer,
        initialText: () => editor.initial,
        setInitialText: (value) => { editor.initial = value; }
      }
    : null;
}
