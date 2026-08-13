import { createComposer } from "./composer-model.js";
import {
  beginSettingsPasteEdit,
  boundedSettingsCursor,
  SETTINGS_ROW_IDS
} from "./settings-overlay-model.js";
import type { InlineEditorSession, RuntimeState } from "./state.js";

/** Open the global-scope system prompt in the canonical full-screen editor. */
export function openSystemPromptEditor(state: RuntimeState): void {
  const overlay = state.settings;
  if (overlay === null) return;
  const initial = overlay.draft.generation.systemPrompt;
  const composer = createComposer(initial);
  if (initial.length > 0) composer.anchor = 0;
  const editor: InlineEditorSession = {
    kind: "document",
    composer,
    initial,
    title: "system prompt",
    placeholder: "Write the default model instructions…",
    conflict: null,
    returnMode: "SETTINGS",
    target: { kind: "settings-prompt", owner: overlay, scope: "global" }
  };
  state.editor = editor;
  state.editorScrollTop = 0;
  state.editorScrollDetached = false;
  state.mode = "EDITOR";
}

/** Give native or clipboard paste one canonical Settings text owner. */
export function openSettingsPasteTarget(
  state: RuntimeState
): "editor" | "inline" | null {
  const overlay = state.settings;
  if (overlay === null) return null;
  if (overlay.profileTransfer !== null) return null;
  if (overlay.sampling !== null) {
    return overlay.sampling.edit === null ? null : "inline";
  }
  const row = SETTINGS_ROW_IDS[boundedSettingsCursor(overlay.cursor)]!;
  if (row === "system-prompt") {
    if (!overlay.view.editable) return null;
    openSystemPromptEditor(state);
    return state.editor?.target.kind === "settings-prompt"
      ? "editor"
      : null;
  }
  return beginSettingsPasteEdit(overlay, state.config) ? "inline" : null;
}
