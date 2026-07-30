import {
  composerSelection,
  redoComposerEdit,
  selectedComposerText,
  undoComposerEdit
} from "./composer-model.js";
import { applyComposerEdit } from "./composer-editing.js";
import { moveComposerVisualVertical } from "./composer-visual-movement.js";
import { copyToClipboard, readFromClipboard } from "./clipboard.js";
import {
  insertEditorText,
  type EditorTextBuffer,
  type EditorTextInsertionPolicy
} from "./editor-text-insertion.js";
import { sanitizePastedText, type ResolvedKey } from "./keys.js";

export type EditorBuffer = EditorTextBuffer;

export interface EditorBufferHost {
  interactionVersion: number;
  toast: string | null;
}

export type EditorBufferOutcome =
  | "handled"
  | "cancel"
  | "save"
  | "save-inplace"
  | "unhandled";

export interface EditorBufferActionOptions extends EditorTextInsertionPolicy {
  readonly isCurrent: () => boolean;
  readonly wrapWidth: number;
}

/** Shared multiline-buffer reducer. Target owners keep save, cancel, conflict,
 * and persistence policy; this function owns editing and clipboard behavior. */
export async function editorBufferAction(
  resolved: ResolvedKey,
  host: EditorBufferHost,
  buffer: EditorBuffer,
  options: EditorBufferActionOptions
): Promise<EditorBufferOutcome> {
  if (resolved.action === "cancel") return "cancel";
  if (resolved.action === "save-edit") return "save";
  if (resolved.action === "save-edit-inplace") return "save-inplace";
  if (resolved.action === "copy-selection") {
    await copySelection(host, buffer, options, false);
    return "handled";
  }
  if (resolved.action === "cut-selection") {
    await copySelection(host, buffer, options, true);
    return "handled";
  }
  if (resolved.action === "paste-clipboard") {
    await pasteClipboard(host, buffer, options);
    return "handled";
  }
  if (resolved.action === "newline") {
    insertEditorText(host, buffer, options, "\n", "newline");
    return "handled";
  }
  if (resolved.action === "cursor-up" || resolved.action === "cursor-down") {
    moveComposerVisualVertical(
      buffer.composer,
      resolved.action === "cursor-up" ? -1 : 1,
      options.wrapWidth,
      resolved.extendSelection
    );
    return "handled";
  }
  const kind = applyComposerEdit(
    buffer.composer,
    resolved.action,
    resolved.extendSelection
  );
  if (kind !== null) {
    if (kind === "delete") disarm(buffer, options);
    return "handled";
  }
  if (resolved.action === "undo-edit" || resolved.action === "redo-edit") {
    const changed = resolved.action === "undo-edit"
      ? undoComposerEdit(buffer.composer)
      : redoComposerEdit(buffer.composer);
    if (changed) disarm(buffer, options);
    else host.toast = resolved.action === "undo-edit"
      ? "nothing to undo"
      : "nothing to redo";
    return "handled";
  }
  if (resolved.action === "input") {
    insertEditorText(host, buffer, options, resolved.text ?? "", "input");
    return "handled";
  }
  return "unhandled";
}

async function pasteClipboard(
  host: EditorBufferHost,
  buffer: EditorBuffer,
  options: EditorBufferActionOptions
): Promise<void> {
  const claim = inputClaim(host, buffer);
  const text = await readFromClipboard();
  if (!claimIsCurrent(claim, host, buffer, options)) return;
  if (text === null) {
    host.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    return;
  }
  const clean = sanitizePastedText(text);
  if (clean.length === 0) {
    host.toast = "clipboard has no insertable text";
    return;
  }
  insertEditorText(host, buffer, options, clean, "paste");
}

async function copySelection(
  host: EditorBufferHost,
  buffer: EditorBuffer,
  options: EditorBufferActionOptions,
  cut: boolean
): Promise<void> {
  const selection = composerSelection(buffer.composer);
  const text = selectedComposerText(buffer.composer);
  if (selection === null || text === null) {
    buffer.cutConfirmation = null;
    host.toast = "nothing selected";
    return;
  }
  if (!cut) buffer.cutConfirmation = null;
  const interactionVersion = host.interactionVersion;
  const outcome = await copyToClipboard(text);
  if (!options.isCurrent() || host.interactionVersion !== interactionVersion) {
    return;
  }
  if (outcome === "unavailable") {
    buffer.cutConfirmation = null;
    host.toast = "no clipboard available · selection kept";
    return;
  }
  if (cut) {
    if (outcome !== "command") {
      const confirmation = buffer.cutConfirmation;
      if (confirmation?.start !== selection.start
        || confirmation.end !== selection.end
        || confirmation.text !== text) {
        buffer.cutConfirmation = { ...selection, text };
        host.toast = "clipboard write unconfirmed · ctrl+x again cuts anyway";
        return;
      }
    }
    const current = composerSelection(buffer.composer);
    if (current?.start !== selection.start
      || current.end !== selection.end
      || selectedComposerText(buffer.composer) !== text) {
      host.toast = "selection changed · copied without cutting";
      return;
    }
    insertEditorText(host, buffer, {
      ...options,
      insert: () => ({ text: "" })
    }, "", "input");
  }
  buffer.cutConfirmation = null;
  host.toast = cut ? "selection cut" : "selection copied";
}

function disarm(
  buffer: EditorBuffer,
  options: EditorBufferActionOptions
): void {
  options.disarmConflict();
  buffer.cutConfirmation = null;
}

function inputClaim(
  host: EditorBufferHost,
  buffer: EditorBuffer
): {
  interactionVersion: number;
  text: string;
  cursor: number;
  anchor: number | null;
} {
  return {
    interactionVersion: host.interactionVersion,
    text: buffer.composer.text,
    cursor: buffer.composer.cursor,
    anchor: buffer.composer.anchor
  };
}

function claimIsCurrent(
  claim: ReturnType<typeof inputClaim>,
  host: EditorBufferHost,
  buffer: EditorBuffer,
  options: EditorBufferActionOptions
): boolean {
  return options.isCurrent()
    && host.interactionVersion === claim.interactionVersion
    && buffer.composer.text === claim.text
    && buffer.composer.cursor === claim.cursor
    && buffer.composer.anchor === claim.anchor;
}
