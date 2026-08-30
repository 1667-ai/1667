import { beginInteraction } from "./action-runtime.js";
import type { ActionContext } from "./action-context.js";
import type { AppSource } from "./app.js";
import { claimAsideComposer } from "./aside-surface.js";
import { sanitizePastedText, pasteInto } from "./keys.js";
import { handleOverlayAction } from "./overlay-actions.js";
import {
  pastePlainText,
  plainTextPasteTarget
} from "./plain-text-paste.js";
import { openSettingsPasteTarget } from "./settings-prompt-editor.js";
import type { RuntimeState } from "./state.js";

/** Apply one admitted terminal paste through the visible text owner's reducer. */
export async function applyTerminalPaste(
  raw: string,
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const clean = sanitizePastedText(raw);
  if (clean.length === 0) return false;
  if (state.mode === "SETTINGS" && state.settings !== null) {
    openSettingsPasteTarget(state);
  }
  const target = plainTextPasteTarget(state, source, context);
  if (target !== null) {
    beginInteraction(state);
    if (await pastePlainText(target, clean)) context.repaint();
    return true;
  }
  if (state.mode === "ASIDE") {
    if (!claimAsideComposer(state.aside)) return false;
    beginInteraction(state);
    await handleOverlayAction({ action: "input", text: clean }, state, source, context);
    context.repaint();
    return true;
  }
  if (!pasteInto(state, clean)) return false;
  beginInteraction(state);
  context.repaint();
  return true;
}
