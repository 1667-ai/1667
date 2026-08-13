import { readClipboardContent } from "./clipboard.js";
import {
  composerClipboardAction,
  type ComposerClipboardHost
} from "./composer-clipboard-action.js";
import {
  applyComposerEdit,
  applyComposerHistoryEdit,
  type ComposerEditKind
} from "./composer-editing.js";
import type { ComposerVerticalMotion } from "./composer-motion.js";
import { insertComposerText, type ComposerState } from "./composer-model.js";
import { sanitizePastedText, type ResolvedKey } from "./keys.js";

export interface ComposerSurfaceActionOptions {
  readonly isCurrent: () => boolean;
  readonly pageRows: number;
  readonly motion: ComposerVerticalMotion;
  /** Reshape pasted text before it lands. Single-line fields pass a newline
   *  flattener so a multi-line clipboard paste cannot split the field. */
  readonly insert?: (text: string) => string;
  readonly onEdit?: (kind: ComposerEditKind | "history") => void;
}

/** Apply commands shared by Direct and single-line composer-backed fields. */
export async function composerSurfaceAction(
  resolved: ResolvedKey,
  host: ComposerClipboardHost,
  composer: ComposerState,
  options: ComposerSurfaceActionOptions
): Promise<boolean> {
  if (resolved.action === "cut-selection") {
    await composerClipboardAction(host, composer, true, {
      isCurrent: options.isCurrent,
      deleteSelection: () => {
        options.onEdit?.("delete");
        insertComposerText(composer, "");
      }
    });
    return true;
  }
  if (resolved.action === "cursor-page-up" || resolved.action === "cursor-page-down") {
    options.motion.rows(
      composer,
      (resolved.action === "cursor-page-up" ? -1 : 1) * options.pageRows,
      resolved.extendSelection
    );
    return true;
  }
  if (resolved.action === "paste-clipboard") {
    await pasteComposerClipboard(host, composer, options);
    return true;
  }
  const edit = applyComposerEdit(composer, resolved.action, resolved.extendSelection);
  if (edit !== null) {
    options.onEdit?.(edit);
    return true;
  }
  const history = applyComposerHistoryEdit(composer, resolved.action);
  if (history === null) return false;
  if (history) options.onEdit?.("history");
  else host.toast = resolved.action === "undo-edit"
    ? "nothing to undo"
    : "nothing to redo";
  return true;
}

/** Snapshot the claim, read the clipboard, then re-check it before applying
 *  the result — the read is asynchronous, and the field or the interaction
 *  can move on before it resolves. Shared by every composer-backed surface
 *  this reducer serves, so a stale read never lands over newer typing. */
async function pasteComposerClipboard(
  host: ComposerClipboardHost,
  composer: ComposerState,
  options: ComposerSurfaceActionOptions
): Promise<void> {
  const claim = {
    interactionVersion: host.interactionVersion,
    text: composer.text,
    cursor: composer.cursor,
    anchor: composer.anchor
  };
  const content = await readClipboardContent();
  if (!options.isCurrent()
    || host.interactionVersion !== claim.interactionVersion
    || composer.text !== claim.text
    || composer.cursor !== claim.cursor
    || composer.anchor !== claim.anchor) {
    return;
  }
  if (content === null) {
    host.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    return;
  }
  // Every field this helper serves besides the story composer is plain
  // text (a rename, a settings value, a Fact field): an image clipboard
  // result has nothing to insert here. The story composer's own paste path
  // (compose-clipboard.ts) is the one place a clipboard image attaches.
  if (content.type === "image") {
    host.toast = "clipboard has no insertable text";
    return;
  }
  const clean = sanitizePastedText(content.text);
  if (clean.length === 0) {
    host.toast = "clipboard has no insertable text";
    return;
  }
  insertComposerText(composer, options.insert?.(clean) ?? clean);
  options.onEdit?.("insert");
}
