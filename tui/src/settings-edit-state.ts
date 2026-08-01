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
  close?(): void;
}

/** Derive the visible Settings edit from its one canonical owner. */
export function activeSettingsEdit(
  state: Pick<RuntimeState, "mode" | "editor" | "settings">,
  overlay: SettingsOverlayState
): ActiveSettingsEdit | null {
  if (state.settings !== overlay) return null;
  if (state.mode === "SETTINGS") {
    const samplingEdit = overlay.sampling?.edit;
    if (samplingEdit !== null && samplingEdit !== undefined) {
      return {
        row: "sampling",
        composer: samplingEdit.composer,
        initialText: () => samplingEdit.initial,
        setInitialText: (value) => { samplingEdit.initial = value; },
        close: () => {
          if (overlay.sampling?.edit === samplingEdit) overlay.sampling.edit = null;
        }
      };
    }
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
