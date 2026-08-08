import {
  applyComposerEdit,
  applyComposerHistoryEdit,
  moveComposerPage
} from "./composer-editing.js";
import { moveComposerVertical } from "./composer-model.js";
import {
  moveComposerVisualRows,
  moveComposerVisualVertical
} from "./composer-visual-movement.js";
import { readFromClipboard } from "./clipboard.js";
import { composerClipboardAction } from "./composer-clipboard-action.js";
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
  readonly pageRows: number;
  /** Vertical motion follows the paint: wrapped rows when the editor wraps,
   *  logical lines when it does not. */
  readonly softWrap: boolean;
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
    await selectionClipboardAction(host, buffer, options, false);
    return "handled";
  }
  if (resolved.action === "cut-selection") {
    await selectionClipboardAction(host, buffer, options, true);
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
    const direction = resolved.action === "cursor-up" ? -1 : 1;
    if (options.softWrap) {
      moveComposerVisualVertical(
        buffer.composer, direction, options.wrapWidth, resolved.extendSelection
      );
    } else moveComposerVertical(buffer.composer, direction, resolved.extendSelection);
    return "handled";
  }
  if (resolved.action === "cursor-page-up" || resolved.action === "cursor-page-down") {
    const direction = resolved.action === "cursor-page-up" ? -1 : 1;
    if (options.softWrap) {
      moveComposerVisualRows(
        buffer.composer,
        direction * options.pageRows,
        options.wrapWidth,
        resolved.extendSelection
      );
    } else {
      moveComposerPage(
        buffer.composer, direction, options.pageRows, resolved.extendSelection
      );
    }
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
  const history = applyComposerHistoryEdit(buffer.composer, resolved.action);
  if (history !== null) {
    if (history) disarm(buffer, options);
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

async function selectionClipboardAction(
  host: EditorBufferHost,
  buffer: EditorBuffer,
  options: EditorBufferActionOptions,
  cut: boolean
): Promise<void> {
  await composerClipboardAction(host, buffer.composer, cut, {
    isCurrent: options.isCurrent,
    deleteSelection: () => insertEditorText(host, buffer, {
      ...options,
      insert: () => ({ text: "" })
    }, "", "input")
  });
}

function disarm(
  buffer: EditorBuffer,
  options: EditorBufferActionOptions
): void {
  options.disarmConflict();
  buffer.composer.cutConfirmation = null;
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
