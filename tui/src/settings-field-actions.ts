import type { AppSource } from "./app.js";
import { insertComposerText } from "./composer-model.js";
import { composerSurfaceAction } from "./composer-surface-action.js";
import { SINGLE_LINE_COMPOSER_MOTION } from "./composer-motion.js";
import { readFromClipboard } from "./clipboard.js";
import { applyTextKey, sanitizePastedText, type ResolvedKey } from "./keys.js";
import {
  boundedModelPickerCursor,
  modelPickerRows
} from "./settings-model-picker.js";
import {
  applySettingsModelChoice
} from "./settings-model-selection.js";
import {
  applySettingsRowEdit,
  disarmSettingsConflict,
  settingsDraftChanged
} from "./settings-overlay-model.js";
import {
  applySettingsLocalToggle,
  applySettingsAsideThoughts,
  applySettingsTheme
} from "./settings-selector-actions.js";
import type { RuntimeState, SettingsOverlayState } from "./state.js";
import type { ActionContext } from "./action-context.js";

/** The two states a Settings row can take the keyboard in: the inline editor
 *  over one field, and C-15's option column over a long list. Both are modal
 *  over the field list, and both belong together rather than beside the
 *  panel-wide verbs. */

/** C-15's own keys. Typing narrows the column live; `↵` takes the focused
 *  option, or the text itself when nothing matches, so a model the provider
 *  never listed is still reachable from here. */
export function settingsModelPickerAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  overlay: SettingsOverlayState
): void {
  const picker = overlay.modelPicker!;
  const rows = modelPickerRows(overlay, picker.query);
  // One row past the choices: `use what you typed`.
  const stops = rows.length + 1;
  if (resolved.action === "focus-next" || resolved.action === "focus-previous") {
    picker.cursor = boundedModelPickerCursor(
      picker.cursor + (resolved.action === "focus-next" ? 1 : -1),
      stops
    );
    return;
  }
  if (resolved.action === "focus-index" && resolved.index !== undefined) {
    picker.cursor = boundedModelPickerCursor(resolved.index, stops);
    return;
  }
  if (resolved.action === "input" || resolved.action === "backspace") {
    picker.query = applyTextKey(picker.query, resolved) ?? picker.query;
    picker.cursor = 0;
    return;
  }
  if (resolved.action !== "open-selected") return;
  // `use what you typed` is the last row, so a typed identifier that merely
  // prefixes a discovered one — `gpt-4o` beside `gpt-4o-mini` — stays usable.
  const cursor = boundedModelPickerCursor(picker.cursor, rows.length + 1);
  const chosen = rows[cursor];
  const model = chosen?.remoteId ?? picker.query.trim();
  overlay.modelPicker = null;
  if (model.length === 0) return;
  applySettingsModelChoice(overlay, {
    remoteId: model,
    contextWindow: chosen?.contextWindow ?? null
  }, undefined, chosen === undefined ? { kind: "typed" } : { kind: "manual" });
  state.toast = `model · ${model} · s saves settings`;
  // The auto-detect probe fires from settingsOverlayAction's one seam for
  // every path that can change the model, this one included — not from
  // here.
}

export async function settingsInlineEditAction(
  resolved: ResolvedKey,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  overlay: SettingsOverlayState
): Promise<void> {
  const edit = overlay.edit;
  if (edit?.kind !== "inline") return;
  if (resolved.action === "paste-clipboard") {
    const inputClaim = {
      interactionVersion: state.interactionVersion,
      text: edit.composer.text,
      cursor: edit.composer.cursor,
      anchor: edit.composer.anchor
    };
    const text = await readFromClipboard();
    if (state.settings !== overlay || overlay.edit !== edit) return;
    if (state.interactionVersion !== inputClaim.interactionVersion
      || edit.composer.text !== inputClaim.text
      || edit.composer.cursor !== inputClaim.cursor
      || edit.composer.anchor !== inputClaim.anchor) {
      return;
    }
    if (text === null) {
      state.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    } else if (!pasteSettingsInlineEdit(overlay, text)) {
      state.toast = "clipboard has no insertable text";
    }
    return;
  }
  if (resolved.action === "commit-field") {
    const applied = applySettingsRowEdit(overlay, state.config);
    if (applied.kind === "error") {
      state.toast = `row kept · ${applied.message}`;
      return;
    }
    if (applied.kind === "theme") {
      applySettingsTheme(state, context, applied.value);
      return;
    }
    if (applied.kind === "local") {
      applySettingsLocalToggle(state, source, applied.row, applied.value);
      return;
    }
    if (applied.kind === "aside-thoughts") {
      applySettingsAsideThoughts(state, source, applied.value);
      return;
    }
    disarmSettingsConflict(overlay);
    if (settingsDraftChanged(overlay)) {
      state.toast = "draft updated · s saves settings";
    }
    // The auto-detect probe fires from settingsOverlayAction's one seam for
    // every path that can change the model, this one included — not from
    // here.
    return;
  }
  if (resolved.action === "input") {
    disarmSettingsConflict(overlay);
    insertComposerText(edit.composer, resolved.text ?? "");
    return;
  }
  await composerSurfaceAction(resolved, state, edit.composer, {
    isCurrent: () => state.settings === overlay && overlay.edit === edit,
    pageRows: 1,
    motion: SINGLE_LINE_COMPOSER_MOTION,
    onEdit: (kind) => {
      if (kind !== "move") disarmSettingsConflict(overlay);
    }
  });
}

function pasteSettingsInlineEdit(
  overlay: SettingsOverlayState,
  raw: string
): boolean {
  const edit = overlay.edit;
  if (edit?.kind !== "inline") return false;
  const clean = sanitizePastedText(raw);
  if (clean.length === 0) return false;
  disarmSettingsConflict(overlay);
  insertComposerText(edit.composer, clean.replace(/\n+/g, " "));
  return true;
}
