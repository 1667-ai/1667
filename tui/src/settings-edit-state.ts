import type {
  ComposerState
} from "./composer-model.js";
import type {
  RuntimeState,
  SettingsOverlayState,
  SettingsRowId,
  SettingsInlineEditState
} from "./state.js";

type ActiveSettingsRowId = Exclude<SettingsRowId, "sampling">;

export type ActiveSettingsEdit =
  | {
      kind: "row";
      row: ActiveSettingsRowId;
      composer: ComposerState;
      initialText(): string;
      setInitialText(value: string): void;
    }
  | {
      kind: "sampling";
      composer: ComposerState;
      initialText(): string;
      setInitialText(value: string): void;
      close(): void;
    };

type ActiveInlineEdit = {
  kind: "row";
  row: SettingsInlineEditState["row"];
  composer: ComposerState;
  initialText(): string;
  setInitialText(value: string): void;
};

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
        kind: "sampling",
        composer: samplingEdit.composer,
        initialText: () => samplingEdit.initial,
        setInitialText: (value) => { samplingEdit.initial = value; },
        close: () => {
          if (overlay.sampling?.edit === samplingEdit) overlay.sampling.edit = null;
        }
      };
    }
    const edit = overlay.edit;
    return edit === null ? null : activeInlineEdit(edit);
  }
  const editor = state.mode === "EDITOR" ? state.editor : null;
  return editor?.kind === "document"
    && editor.target.kind === "settings-prompt"
    && editor.target.owner === overlay
      ? {
        kind: "row",
        row: "system-prompt",
        composer: editor.composer,
        initialText: () => editor.initial,
        setInitialText: (value) => { editor.initial = value; }
      }
    : null;
}

function activeInlineEdit(edit: SettingsInlineEditState): ActiveInlineEdit {
  return {
    kind: "row",
    row: edit.row,
    composer: edit.composer,
    initialText: () => edit.initial,
    setInitialText: (value) => { edit.initial = value; }
  };
}
