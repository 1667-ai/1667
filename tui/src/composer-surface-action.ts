import {
  composerClipboardAction,
  type ComposerClipboardHost
} from "./composer-clipboard-action.js";
import {
  applyComposerEdit,
  applyComposerHistoryEdit,
  moveComposerPage,
  type ComposerEditKind
} from "./composer-editing.js";
import { insertComposerText, type ComposerState } from "./composer-model.js";
import type { ResolvedKey } from "./keys.js";

export interface ComposerSurfaceActionOptions {
  readonly isCurrent: () => boolean;
  readonly pageRows: number;
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
    moveComposerPage(
      composer,
      resolved.action === "cursor-page-up" ? -1 : 1,
      options.pageRows,
      resolved.extendSelection
    );
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
