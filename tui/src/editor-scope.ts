import type {
  DocumentEditorSession,
  InlineEditorSession,
  RuntimeState
} from "./state.js";

type GlobalEditor = InlineEditorSession & {
  target: Extract<InlineEditorSession["target"], { scope: "global" }>;
};

function isGlobalEditor(
  editor: DocumentEditorSession | null
): editor is GlobalEditor {
  return editor?.kind === "document"
    && editor.target.kind === "settings-prompt";
}

/** Find the editor that owns application settings instead of story data. */
export function globalEditor(
  state: Pick<RuntimeState, "mode" | "editor">
): GlobalEditor | null {
  const editor = state.mode === "EDITOR" ? state.editor : null;
  return isGlobalEditor(editor) ? editor : null;
}
