import {
  isWritingPromptRow,
  writingPromptFieldDefinitionForRow,
  type WritingPromptRowId
} from "../../shared/settings-v5-writing.js";
import { createComposer } from "./composer-model.js";
import {
  beginSettingsPasteEdit,
  boundedSettingsCursor,
  settingsRowIds
} from "./settings-overlay-model.js";
import { draftWriting, writingPromptBudgetStatus } from "./settings-writing-draft.js";
import type { DocumentEditorSession, InlineEditorSession, RuntimeState } from "./state.js";
import type { ComposerStatus } from "./screens/story/composer-chrome.js";

/** Open one table-driven writing prompt in the canonical full-screen editor. */
export function openWritingPromptEditor(
  state: RuntimeState,
  row: WritingPromptRowId
): void {
  const overlay = state.settings;
  if (overlay === null) return;
  const definition = writingPromptFieldDefinitionForRow(row);
  const initial = draftWriting(overlay.draft)[definition.field];
  const composer = createComposer(initial);
  if (initial.length > 0) composer.anchor = 0;
  const editor: InlineEditorSession = {
    kind: "document",
    composer,
    initial,
    title: definition.title,
    placeholder: definition.placeholder,
    conflict: null,
    returnMode: "SETTINGS",
    target: { kind: "settings-prompt", owner: overlay, row, scope: "global" }
  };
  state.editor = editor;
  state.editorScrollTop = 0;
  state.editorScrollDetached = false;
  state.mode = "EDITOR";
}

/** @deprecated Use openWritingPromptEditor with the selected writing row. */
export function openSystemPromptEditor(state: RuntimeState): void {
  openWritingPromptEditor(state, "default-author-brief");
}

export function writingPromptEditorStatus(
  host: DocumentEditorSession,
  width: number
): ComposerStatus | undefined {
  if (host.kind !== "document" || host.target.kind !== "settings-prompt") return undefined;
  const definition = writingPromptFieldDefinitionForRow(host.target.row);
  const maxWidth = Math.max(1, width - [...`┏━ ${host.title} `].length - 1);
  return writingPromptBudgetStatus(
    definition,
    host.composer.text,
    draftWriting(host.target.owner.draft),
    maxWidth
  );
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
  const row = settingsRowIds(overlay)[boundedSettingsCursor(overlay.cursor, overlay)]!;
  if (isWritingPromptRow(row)) {
    if (!overlay.view.editable) return null;
    openWritingPromptEditor(state, row);
    return state.editor?.target.kind === "settings-prompt"
      ? "editor"
      : null;
  }
  return beginSettingsPasteEdit(overlay, state.config) ? "inline" : null;
}
