import type { AppSource } from "./app.js";
import type { ActionContext } from "./action-context.js";
import { noteAsidePaletteInteraction } from "./aside-actions.js";
import { readFromClipboard } from "./clipboard.js";
import { sanitizePastedText } from "./keys.js";
import { handleOverlayAction } from "./overlay-actions.js";
import { searchAction } from "./search-actions.js";
import type { RuntimeState } from "./state.js";
import { tagAction } from "./story-actions.js";

export interface PlainTextPasteTarget {
  isCurrent(): boolean;
  paste(line: string): void | Promise<void>;
}

function overlayInputTarget(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext,
  isCurrent: () => boolean,
  prepare: (line: string) => string | null = (line) => line
): PlainTextPasteTarget {
  return {
    isCurrent,
    async paste(line) {
      const text = prepare(line);
      if (text === null) return;
      await handleOverlayAction({ action: "input", text }, state, source, context);
    }
  };
}

/** Capture the one non-composer field that owns plain-text paste. */
export function plainTextPasteTarget(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): PlainTextPasteTarget | null {
  if (state.mode === "SETTINGS" && state.settings !== null) {
    const overlay = state.settings;
    const picker = overlay.modelPicker;
    if (picker !== null) {
      return overlayInputTarget(
        state,
        source,
        context,
        () => state.mode === "SETTINGS" && state.settings === overlay
          && overlay.modelPicker === picker,
        (line) => {
          const clean = line.replace(/\s+/gu, " ").trim();
          if (clean.length === 0) {
            state.toast = "clipboard has no insertable text";
            return null;
          }
          return clean;
        }
      );
    }
    const transfer = overlay.profileTransfer;
    if (transfer?.phase === "file") {
      return overlayInputTarget(
        state,
        source,
        context,
        () => state.mode === "SETTINGS" && state.settings === overlay
          && overlay.profileTransfer === transfer
      );
    }
  }
  if (state.mode === "SEARCH" && state.search !== null) {
    const owner = state.search;
    return {
      isCurrent: () => state.mode === "SEARCH" && state.search === owner,
      paste: (line) => searchAction({ action: "input", text: line }, state, source, context)
    };
  }
  if (state.mode === "COMMANDS" && state.commands?.view === "commands") {
    const owner = state.commands;
    return overlayInputTarget(
      state,
      source,
      context,
      () => state.mode === "COMMANDS" && state.commands === owner
        && owner.view === "commands"
    );
  }
  if (state.mode === "TAG" && state.tag !== null && !state.tag.choosingStatus) {
    const owner = state.tag;
    return {
      isCurrent: () => state.mode === "TAG" && state.tag === owner && !owner.choosingStatus,
      paste: (line) => tagAction({ action: "input", text: line }, state, source, context)
    };
  }
  if (state.mode === "FACTS" && state.facts?.filtering === true) {
    const owner = state.facts;
    return overlayInputTarget(
      state,
      source,
      context,
      () => state.mode === "FACTS" && state.facts === owner && owner.filtering
    );
  }
  if (state.mode === "CARD" && state.card !== null) {
    const owner = state.card;
    return overlayInputTarget(
      state, source, context, () => state.mode === "CARD" && state.card === owner
    );
  }
  if (state.mode === "ARCHIVE" && state.archive !== null) {
    const owner = state.archive;
    return overlayInputTarget(
      state, source, context, () => state.mode === "ARCHIVE" && state.archive === owner
    );
  }
  if (state.mode === "IMAGE" && state.image != null) {
    const owner = state.image;
    return overlayInputTarget(
      state, source, context, () => state.mode === "IMAGE" && state.image === owner
    );
  }
  if (state.mode === "LIBRARY" && state.library !== null) {
    const owner = state.library;
    const prompt = owner.prompt;
    if (prompt?.kind === "filter") {
      return overlayInputTarget(
        state,
        source,
        context,
        () => state.mode === "LIBRARY" && state.library === owner
          && owner.prompt === prompt
      );
    }
    if (prompt?.kind === "delete") {
      return overlayInputTarget(
        state,
        source,
        context,
        () => state.mode === "LIBRARY" && state.library === owner
          && owner.prompt === prompt
      );
    }
  }
  return null;
}

/** Apply terminal paste to a captured plain-text owner. */
export async function pastePlainText(
  target: PlainTextPasteTarget,
  raw: string
): Promise<boolean> {
  const clean = sanitizePastedText(raw);
  if (clean.length === 0 || !target.isCurrent()) return false;
  await target.paste(clean.replace(/\n+/g, " "));
  return true;
}

/** Read Ctrl/Cmd+V once, then apply it only to the captured field owner. */
export async function pastePlainTextFromClipboard(
  state: RuntimeState,
  source: AppSource,
  context: ActionContext
): Promise<boolean> {
  const target = plainTextPasteTarget(state, source, context);
  if (target === null) return false;
  // A palette paste can wait on the host clipboard while a suspended Aside
  // Ask settles. Advance its restore fence before that await, so a null or
  // failed response still returns the question to the Aside composer.
  noteAsidePaletteInteraction(state);
  const interactionVersion = state.interactionVersion;
  const text = await readFromClipboard();
  if (state.interactionVersion !== interactionVersion || !target.isCurrent()) return true;
  if (text === null) {
    state.toast = "clipboard unreadable · paste with ⌘V or ctrl+shift+v";
    return true;
  }
  if (sanitizePastedText(text).length === 0) {
    state.toast = "clipboard has no insertable text";
    return true;
  }
  await pastePlainText(target, text);
  return true;
}
