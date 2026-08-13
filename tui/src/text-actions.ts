import { composerSelection, type ComposerState } from "./composer-model.js";
import {
  factEditorActiveTextComposer,
  factEditorComposerForSource
} from "./fact-editor-policy.js";
import type { KeyAction, ResolvedKey } from "./keys.js";
import type { ComposerSelectionProjection } from "./selection-projection.js";
import type { RuntimeState } from "./state.js";

export interface TextAction {
  id: "copy" | "paste" | "select-all";
  name: string;
  description: string;
  action: Extract<KeyAction, "copy-selection" | "paste-clipboard" | "select-all">;
}

export const TEXT_ACTIONS: readonly TextAction[] = [
  { id: "copy", name: "Copy", description: "copy the selected text", action: "copy-selection" },
  { id: "paste", name: "Paste", description: "insert text from the clipboard", action: "paste-clipboard" },
  { id: "select-all", name: "Select all", description: "select the complete text", action: "select-all" }
];

export function availableTextActions(
  overlay: Pick<NonNullable<RuntimeState["textActions"]>, "copyOnly">
): readonly TextAction[] {
  return overlay.copyOnly ? TEXT_ACTIONS.slice(0, 1) : TEXT_ACTIONS;
}

type TextOwnerState = Pick<RuntimeState, "mode" | "composer" | "editor" | "settings" | "library">
  & { aside?: RuntimeState["aside"] };

/** Find the composer-backed field that currently owns text input. */
export function activeTextComposer(state: TextOwnerState): ComposerState | null {
  if (state.mode === "COMPOSE") return state.composer;
  if (state.mode === "ASIDE") return state.aside?.composer ?? null;
  if (state.mode === "EDITOR" && state.editor !== null) {
    return state.editor.kind === "fact"
      ? factEditorActiveTextComposer(state.editor)
      : state.editor.composer;
  }
  if (state.mode === "LIBRARY") {
    return state.library?.prompt?.kind === "rename" ? state.library.prompt.composer : null;
  }
  if (state.mode !== "SETTINGS" || state.settings === null) return null;
  const sampling = state.settings.sampling?.edit;
  if (sampling !== null && sampling !== undefined) return sampling.composer;
  const edit = state.settings.edit;
  return edit?.kind === "inline" ? edit.composer : null;
}

export function openTextActions(
  state: RuntimeState,
  nativeSelection: ResolvedKey["nativeSelection"] = undefined,
  composerSelectionProjection: ComposerSelectionProjection | null = null,
  composerSourceId?: string,
  copyOnly = false
): void {
  const owner = state.mode === "EDITOR"
    && state.editor?.kind === "fact"
    && composerSourceId !== undefined
    ? factEditorComposerForSource(state.editor, composerSourceId)
    : activeTextComposer(state);
  if (owner === null && !copyOnly) return;
  state.textActions = {
    owner,
    ownerSnapshot: owner === null ? null : {
      text: owner.text,
      cursor: owner.cursor,
      anchor: owner.anchor,
      fullscreen: owner.fullscreen
    },
    cursor: copyOnly || owner !== null && composerSelection(owner) !== null
      || (nativeSelection?.text.length ?? 0) > 0 ? 0 : 1,
    nativeSelection,
    composerSelectionProjection,
    copyOnly
  };
}

/** Reduce the menu and return the editor action that its chosen row names. */
export function textActionsMenuAction(
  resolved: ResolvedKey,
  state: RuntimeState
): ResolvedKey | null {
  const overlay = state.textActions;
  if (overlay === null) return null;
  const actions = availableTextActions(overlay);
  if (resolved.action === "cancel") {
    state.textActions = null;
    return null;
  }
  if (resolved.action === "focus-next") {
    overlay.cursor = Math.min(actions.length - 1, overlay.cursor + 1);
    return null;
  }
  if (resolved.action === "focus-previous") {
    overlay.cursor = Math.max(0, overlay.cursor - 1);
    return null;
  }
  if (resolved.action === "focus-index") {
    overlay.cursor = Math.max(0, Math.min(
      actions.length - 1,
      resolved.index ?? overlay.cursor
    ));
    return null;
  }
  if (resolved.action !== "apply" && resolved.action !== "open-selected") return null;
  const selected = actions[overlay.cursor];
  state.textActions = null;
  if (selected === undefined) return null;
  if (overlay.owner !== null && (activeTextComposer(state) !== overlay.owner
    || overlay.ownerSnapshot === null
    || overlay.owner.text !== overlay.ownerSnapshot.text
    || overlay.owner.cursor !== overlay.ownerSnapshot.cursor
    || overlay.owner.anchor !== overlay.ownerSnapshot.anchor
    || overlay.owner.fullscreen !== overlay.ownerSnapshot.fullscreen)) {
    state.toast = "editor changed · open the menu again";
    return null;
  }
  return { action: selected.action };
}
