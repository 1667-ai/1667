import type { KeyEvent } from "@opentui/core";
import { insertComposerText, type ComposerState } from "./composer-model.js";
import { openDirectComposer } from "./composer-ownership.js";
import type { MapView } from "./map-state.js";
import type { StorySelectionSpan } from "./selection-projection.js";
import type {
  InlineEditorSession,
  PendingGenerationDraft,
  RetakePromptSession,
  RuntimeState,
  SettingsRowId
} from "./state.js";

export type KeyAction =
  | "focus-next" | "focus-previous" | "take-next" | "take-previous" | "take-at"
  | "undo" | "top" | "leaf" | "toggle-instructions" | "toggle-prompt" | "compose"
  | "cancel" | "quit" | "send" | "newline" | "history-previous"
  | "save-edit" | "commit-field"
  | "history-next" | "backspace" | "input" | "none" | "open-map"
  | "cycle-map-view" | "toggle-path-takes" | "toggle-sketches" | "map-follow" | "map-cycle-sort"
  | "set-map-view"
  | "cursor-left" | "cursor-right" | "cursor-up" | "cursor-down" | "toggle-compose-fullscreen"
  | "select-left" | "select-right" | "select-up" | "select-down"
  | "cursor-word-left" | "cursor-word-right" | "select-word-left" | "select-word-right"
  | "cursor-line-start" | "cursor-line-end" | "select-line-start" | "select-line-end"
  | "cursor-buffer-start" | "cursor-buffer-end" | "select-buffer-start" | "select-buffer-end"
  | "delete-forward" | "delete-word-left" | "delete-word-right" | "delete-line"
  | "delete-line-start" | "delete-line-end" | "select-all"
  | "copy-selection" | "cut-selection" | "paste-clipboard" | "undo-edit" | "redo-edit"
  | "open-keys" | "prune" | "bookmark" | "delete-bookmark"
  | "typewriter" | "edit" | "write" | "regenerate" | "retake-with-prompt" | "apply"
  | "open-library" | "open-facts" | "open-commands" | "open-settings"
  | "open-selected" | "new-item" | "rename-item" | "delete-item"
  | "filter" | "cycle" | "check" | "detect-context" | "discard-pending" | "retry" | "continue"
  | "scroll-down" | "scroll-up" | "scroll-line-down" | "scroll-line-up" | "toggle-rail" | "copy-part" | "copy-line" | "open-actions" | "focus-index"
  | "open-chapters" | "create-chapter" | "summarize-chapter" | "chapter-previous" | "chapter-next"
  | "toggle-context-meter";

export type AppMode = "NAV" | "COMPOSE" | "EDITOR" | "MAP" | "KEYS" | "BOOKMARK"
  | "LIBRARY" | "FACTS" | "COMMANDS" | "SUMMARY" | "SETTINGS" | "ACTIONS" | "CHAPTERS";

export interface ResolvedKey {
  action: KeyAction;
  text?: string;
  /** Exact OpenTUI selection captured before a right-click menu repaint. */
  selectionText?: string;
  /** Story-source selection retained without tinting the menu overlay. */
  selectionSpans?: readonly StorySelectionSpan[];
  /** Extend an editor/composer selection instead of only moving its caret. */
  extendSelection?: boolean;
  /** Absolute cursor placement (mouse clicks). */
  index?: number;
  /** Stable story-row identity for deferred prose clicks. */
  rowId?: string;
  /** One-based sibling take selected by an explicit map affordance. */
  take?: number;
  /** Explicit map tab selected by mouse. */
  view?: MapView;
  /** Settings row named by a semantic shortcut outside the Settings panel. */
  settingsRow?: SettingsRowId;
}

export interface PlainNavigationState {
  mode: AppMode;
  prune: unknown | null;
  chapterDeleteArmedId: string | null;
  /** Redundant with ACTIONS mode in a settled frame, but an async
   * reconciliation must not claim the screen while the menu still owns it. */
  actions: unknown | null;
}

/** No modal, map, composer, or destructive confirmation owns the screen. */
export function isPlainNavigation(state: PlainNavigationState): boolean {
  return state.mode === "NAV"
    && state.prune === null
    && state.chapterDeleteArmedId === null
    && state.actions === null;
}

/** Actions that mutate the story and must not run while a stream is active. */
export const MUTATING_ACTIONS: ReadonlySet<KeyAction> = new Set([
  "prune", "apply", "delete-bookmark", "edit", "write", "regenerate", "bookmark",
  "new-item", "rename-item", "delete-item", "discard-pending",
  "create-chapter", "summarize-chapter", "save-edit"
]);

/** Terminals disagree on how shifted letters arrive; accept all three forms. */
function shiftedLetter(key: KeyEvent, letter: string): boolean {
  const upper = letter.toUpperCase();
  return key.name === upper || key.sequence === upper || (key.name === letter && key.shift);
}

function shiftedAsciiLetter(key: KeyEvent): boolean {
  const nameIsLetter = /^[a-z]$/i.test(key.name);
  const sequenceIsLetter = /^[a-z]$/i.test(key.sequence);
  return (nameIsLetter || sequenceIsLetter)
    && (key.shift || /^[A-Z]$/.test(key.name) || /^[A-Z]$/.test(key.sequence));
}

function textInput(key: KeyEvent): ResolvedKey | null {
  if (!key.ctrl && !key.meta && key.sequence.length > 0 && [...key.sequence].length === 1) {
    return { action: "input", text: key.sequence };
  }
  return null;
}

function multilineInput(key: KeyEvent): ResolvedKey {
  const action = key.name === "up" ? "cursor-up"
    : key.name === "down" ? "cursor-down"
      : key.name === "left" ? "cursor-left"
        : key.name === "right" ? "cursor-right"
          : null;
  if (action !== null) {
    return { action, ...(key.shift ? { extendSelection: true } : {}) };
  }
  if (key.name === "backspace") return { action: "backspace" };
  return textInput(key) ?? { action: "none" };
}

/** Apply an input/backspace action to a text value; null = not a text action. */
export function applyTextKey(value: string, resolved: ResolvedKey): string | null {
  if (resolved.action === "input") return value + (resolved.text ?? "");
  if (resolved.action === "backspace") return [...value].slice(0, -1).join("");
  return null;
}

/** Route pasted text into whichever text surface owns the keyboard.
 *  Multiline paste survives in the composer/editor; single-line fields flatten
 *  newlines to spaces. Returns false when nothing accepts text (pure NAV
 *  states get the paste as a fresh composer draft). */
export function pasteInto(
  state: {
    mode: AppMode;
    composer: ComposerState;
    editor?: InlineEditorSession | null;
    bookmark: { choosingLabel: boolean; name: string } | null;
    library: { prompt: { value: string } | null } | null;
    facts: { filtering: boolean; query: string; cursor: number } | null;
    commands: { view: string; query: string } | null;
    chapters?: { rename: { value: string } | null } | null;
    settings?: { edit: { composer: ComposerState } | null } | null;
    prune: unknown | null;
    chapterDeleteArmedId: string | null;
    actions: unknown | null;
    composerScrollTop: number;
    history: string[];
    historyIndex: number;
    historyDraft: string | null;
    retakePrompt: RetakePromptSession | null;
    pendingGenerationDraft: PendingGenerationDraft | null;
    composerClaimEpoch: number;
  },
  raw: string
): boolean {
  const clean = sanitizePastedText(raw);
  if (clean.length === 0) return false;
  const line = clean.replace(/\n+/g, " ");
  if (state.mode === "EDITOR" && state.editor != null) {
    if (state.editor.conflict !== null) state.editor.conflict.armed = false;
    insertComposerText(state.editor.composer, clean);
    return true;
  }
  if (state.mode === "COMPOSE") { insertComposerText(state.composer, clean); return true; }
  if (state.mode === "BOOKMARK" && state.bookmark !== null && !state.bookmark.choosingLabel) {
    state.bookmark.name += line;
    return true;
  }
  if (state.mode === "LIBRARY" && state.library?.prompt != null) {
    state.library.prompt.value += line;
    return true;
  }
  if (state.mode === "FACTS" && state.facts?.filtering === true) {
    state.facts.query += line;
    // A paste can narrow the list without passing through the facts reducer;
    // keep its stored cursor aligned with the newly painted result set.
    state.facts.cursor = 0;
    return true;
  }
  if (state.mode === "COMMANDS" && state.commands?.view === "commands") {
    state.commands.query += line;
    return true;
  }
  const chapterRename = state.mode === "CHAPTERS" ? state.chapters?.rename : null;
  if (chapterRename != null) {
    chapterRename.value += line;
    return true;
  }
  const settingsEdit = state.mode === "SETTINGS" ? state.settings?.edit : null;
  if (settingsEdit != null) {
    insertComposerText(settingsEdit.composer, line);
    return true;
  }
  if (isPlainNavigation(state)) {
    openDirectComposer(state);
    insertComposerText(state.composer, clean);
    return true;
  }
  return false;
}

/** Keep clipboard and bracketed-paste input from injecting terminal controls
 * while preserving tabs and newlines used by multiline editors. */
export function sanitizePastedText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

export interface ResolveOptions {
  confirmingPrune?: boolean;
  bookmarkChoosingLabel?: boolean;
  connectionDown?: boolean;
  /** A text prompt/filter owns the keyboard: letters are input, not hotkeys. */
  overlayTyping?: boolean;
  /** The command palette is showing its bookmarks sub-view. */
  commandsBookmarks?: boolean;
  mapView?: MapView;
}

type OverlayTextInputState = Pick<
  RuntimeState,
  "mode" | "library" | "facts" | "chapters" | "settings"
>;

/** One ownership check shared by key routing and chrome that advertises
 * keyboard shortcuts. Keep every overlay text field on this boundary. */
export function overlayTextInputActive(state: OverlayTextInputState): boolean {
  if (state.mode === "LIBRARY") return state.library?.prompt != null;
  if (state.mode === "FACTS") return state.facts?.filtering === true;
  if (state.mode === "CHAPTERS") return state.chapters?.rename != null;
  if (state.mode === "SETTINGS") return state.settings?.edit != null;
  return false;
}

export function textOwnsKeyboard(mode: AppMode, options: ResolveOptions = {}): boolean {
  return mode === "COMPOSE" || mode === "EDITOR"
    || options.overlayTyping === true
    || mode === "COMMANDS" && options.commandsBookmarks !== true
    || mode === "BOOKMARK" && options.bookmarkChoosingLabel !== true;
}

export function resolveKey(key: KeyEvent, mode: AppMode, options: ResolveOptions = {}): ResolvedKey {
  const { confirmingPrune = false, bookmarkChoosingLabel = false, connectionDown = false,
    overlayTyping = false, commandsBookmarks = false, mapView = "path" } = options;
  if (key.name === "escape") return { action: "cancel" };
  const ownsText = textOwnsKeyboard(mode, {
    overlayTyping, commandsBookmarks, bookmarkChoosingLabel
  });
  // The banner's capital-R shortcut is page/list chrome, never a text-field
  // override. Writers must still be able to type R while working offline.
  if (!key.ctrl && !key.meta && connectionDown && !ownsText && shiftedLetter(key, "r")) {
    return { action: "retry" };
  }
  if (confirmingPrune) {
    return { action: key.name === "d" && !key.ctrl && !key.meta && !key.shift ? "prune" : "none" };
  }
  // Capital letters are distinct terminal commands. Route the declared NAV
  // capitals before rejecting every other shifted spelling; otherwise
  // lowercase-name terminal events can silently trigger lowercase hotkeys.
  if (!key.ctrl && !key.meta && mode === "NAV") {
    if (shiftedLetter(key, "c")) return { action: "create-chapter" };
    if (shiftedLetter(key, "f")) return { action: "toggle-rail" };
    if (shiftedLetter(key, "g")) return { action: "leaf" };
    if (shiftedLetter(key, "r")) return { action: "retake-with-prompt" };
    if (shiftedLetter(key, "y")) return { action: "copy-line" };
  }
  if (!ownsText && shiftedAsciiLetter(key)) return { action: "none" };
  if ((mode === "NAV" || mode === "COMPOSE") && key.ctrl && key.name.toLowerCase() === "g") {
    return { action: "toggle-context-meter" };
  }
  if (mode === "NAV" && key.ctrl && key.name.toLowerCase() === "p") return { action: "open-commands" };
  if (mode === "NAV" && key.ctrl && key.name === "d") return { action: "scroll-down" };
  if (mode === "NAV" && key.ctrl && key.name === "u") return { action: "scroll-up" };
  if (mode === "COMPOSE") {
    if (key.ctrl && key.name.toLowerCase() === "f") return { action: "toggle-compose-fullscreen" };
    if (key.name === "return") return { action: key.shift ? "newline" : "send" };
    if (key.ctrl && key.name === "up") return { action: "history-previous" };
    if (key.ctrl && key.name === "down") return { action: "history-next" };
    return multilineInput(key);
  }
  if (mode === "EDITOR") {
    const name = key.name.toLowerCase();
    const alt = key.meta || key.option;
    if (key.ctrl && name === "s") return { action: "save-edit" };
    if (key.ctrl && name === "c") return { action: "copy-selection" };
    if (key.ctrl && name === "x") return { action: "cut-selection" };
    if (key.ctrl && name === "v") return { action: "paste-clipboard" };
    if ((key.ctrl && name === "z" && !key.shift) || key.ctrl && name === "-"
      || key.super && name === "z" && !key.shift) return { action: "undo-edit" };
    if ((key.ctrl && name === "z" && key.shift) || key.ctrl && (name === "y" || name === ".")
      || key.super && name === "z" && key.shift) {
      return { action: "redo-edit" };
    }
    if (key.super && name === "a") return { action: "select-all" };
    if (key.ctrl && key.shift && name === "d") return { action: "delete-line" };
    if (alt && name === "backspace") return { action: "delete-word-left" };
    if ((key.ctrl && name === "backspace") || key.ctrl && name === "w") return { action: "delete-word-left" };
    if ((key.ctrl || alt) && name === "delete") return { action: "delete-word-right" };
    if (key.ctrl && name === "k") return { action: "delete-line-end" };
    if (key.ctrl && name === "u") return { action: "delete-line-start" };
    if (key.ctrl && name === "a") return { action: key.shift ? "select-line-start" : "cursor-line-start" };
    if (key.ctrl && name === "e") return { action: key.shift ? "select-line-end" : "cursor-line-end" };
    if (key.ctrl && (name === "b" || name === "f")) {
      const left = name === "b";
      return { action: key.shift
        ? left ? "select-left" : "select-right"
        : left ? "cursor-left" : "cursor-right" };
    }
    if (alt && (name === "a" || name === "e")) {
      const start = name === "a";
      return { action: key.shift
        ? start ? "select-line-start" : "select-line-end"
        : start ? "cursor-line-start" : "cursor-line-end" };
    }
    if (alt && (name === "b" || name === "f")) {
      const left = name === "b";
      return { action: key.shift
        ? left ? "select-word-left" : "select-word-right"
        : left ? "cursor-word-left" : "cursor-word-right" };
    }
    if (key.name === "return") return { action: "newline" };
    if (key.name === "home") return { action: key.shift
      ? key.ctrl ? "select-buffer-start" : "select-line-start"
      : key.ctrl ? "cursor-buffer-start" : "cursor-line-start" };
    if (key.name === "end") return { action: key.shift
      ? key.ctrl ? "select-buffer-end" : "select-line-end"
      : key.ctrl ? "cursor-buffer-end" : "cursor-line-end" };
    if (key.name === "up") return { action: key.shift ? "select-up" : "cursor-up" };
    if (key.name === "down") return { action: key.shift ? "select-down" : "cursor-down" };
    if (key.name === "left") {
      if (key.ctrl || alt) return { action: key.shift ? "select-word-left" : "cursor-word-left" };
      return { action: key.shift ? "select-left" : "cursor-left" };
    }
    if (key.name === "right") {
      if (key.ctrl || alt) return { action: key.shift ? "select-word-right" : "cursor-word-right" };
      return { action: key.shift ? "select-right" : "cursor-right" };
    }
    if (key.name === "backspace") return { action: "backspace" };
    if (key.name === "delete" || key.ctrl && name === "d") return { action: "delete-forward" };
    return textInput(key) ?? { action: "none" };
  }
  if (mode === "SETTINGS" && overlayTyping) {
    const name = key.name.toLowerCase();
    if (key.name === "return" || key.ctrl && name === "s") return { action: "commit-field" };
    if ((key.ctrl || key.super) && name === "v") return { action: "paste-clipboard" };
    if (key.super && name === "a") return { action: "select-all" };
    if (key.name === "left") {
      return { action: key.shift ? "select-left" : "cursor-left" };
    }
    if (key.name === "right") {
      return { action: key.shift ? "select-right" : "cursor-right" };
    }
    if (key.name === "home") {
      return { action: key.shift ? "select-line-start" : "cursor-line-start" };
    }
    if (key.name === "end") {
      return { action: key.shift ? "select-line-end" : "cursor-line-end" };
    }
    if (key.name === "backspace") return { action: "backspace" };
    if (key.name === "delete") return { action: "delete-forward" };
    return textInput(key) ?? { action: "none" };
  }
  if (mode === "SETTINGS"
    && (key.ctrl || key.super)
    && key.name.toLowerCase() === "v") {
    return { action: "paste-clipboard" };
  }
  // A modified letter is a chord, never a plain hotkey. Keep unknown
  // terminal/application chords inert on every non-composer surface.
  if (key.ctrl || key.meta) return { action: "none" };
  if (mode === "ACTIONS") {
    if (key.name === "down") return { action: "focus-next" };
    if (key.name === "up") return { action: "focus-previous" };
    if (key.name === "return") return { action: "apply" };
    return { action: "none" };
  }
  if (mode === "KEYS") return { action: "none" };
  if (mode === "SUMMARY") return { action: "none" };
  if (mode === "SETTINGS") {
    if (key.name === "down") return { action: "focus-next" };
    if (key.name === "up") return { action: "focus-previous" };
    if (key.name === "return") return { action: "open-selected" };
    if (key.name === "s") return { action: "save-edit" };
    if (key.name === "c") return { action: "check" };
    if (key.name === "p") return { action: "detect-context" };
    if (key.name === "e") return { action: "edit" };
    if (key.name === "x") return { action: "discard-pending" };
    if (key.name === "left") return { action: "take-previous" };
    if (key.name === "right") return { action: "take-next" };
    return { action: "none" };
  }
  if (mode === "CHAPTERS") {
    if (overlayTyping) {
      if (key.name === "return") return { action: "open-selected" };
      if (key.name === "backspace") return { action: "backspace" };
      return textInput(key) ?? { action: "none" };
    }
    if (key.name === "down") return { action: "focus-next" };
    if (key.name === "up") return { action: "focus-previous" };
    if (key.name === "return") return { action: "open-selected" };
    if (key.name === "s") return { action: "summarize-chapter" };
    if (key.name === "e") return { action: "rename-item" };
    if (key.name === "d") return { action: "delete-item" };
    if (key.name === "n") return { action: "new-item" };
    return { action: "none" };
  }
  if (mode === "LIBRARY" || mode === "FACTS" || mode === "COMMANDS") {
    if (key.name === "return") return { action: "open-selected" };
    if (key.name === "backspace") return { action: "backspace" };
    if (key.name === "down") return { action: "focus-next" };
    if (key.name === "up") return { action: "focus-previous" };
    if (!overlayTyping) {
      if (mode !== "COMMANDS" && key.name === "/") return { action: "filter" };
      if (mode !== "COMMANDS" && key.name === "n") return { action: "new-item" };
      // One verb per gesture across every list: `e` opens the selected row,
      // `d` deletes it. Facts and the bookmark manager used to delete on `x`
      // while the library and chapters deleted on `d`.
      if (mode === "LIBRARY" && key.name === "e") return { action: "rename-item" };
      if (mode === "FACTS" && key.name === "e") return { action: "edit" };
      if (key.name === "d" && (mode === "LIBRARY" || mode === "FACTS"
        || mode === "COMMANDS" && commandsBookmarks)) return { action: "delete-item" };
    }
    if (mode === "FACTS" && key.name === "tab") return { action: "cycle" };
    return textInput(key) ?? { action: "none" };
  }
  if (mode === "BOOKMARK") {
    if (key.name === "return") return { action: "apply" };
    if (bookmarkChoosingLabel && key.name === "left") return { action: "take-previous" };
    if (bookmarkChoosingLabel && key.name === "right") return { action: "take-next" };
    if (key.name === "backspace") return { action: "backspace" };
    if (bookmarkChoosingLabel && key.name === "d") return { action: "delete-bookmark" };
    return textInput(key) ?? { action: "none" };
  }
  if (mode === "MAP") {
    if (key.name === "down") return { action: "focus-next" };
    if (key.name === "up") return { action: "focus-previous" };
    if (mapView === "path" && key.name === "right") return { action: "take-next" };
    if (mapView === "path" && key.name === "left") return { action: "take-previous" };
    if (mapView !== "path" && key.name === "l") return { action: "map-follow" };
    if (key.name === "m") return { action: "cycle-map-view" };
    if (key.name === "a") {
      return { action: mapView === "path" ? "toggle-path-takes" : "toggle-sketches" };
    }
    if (mapView !== "path" && key.name === "s") return { action: "map-cycle-sort" };
    if (key.name === "return") return { action: "apply" };
    if (mapView === "path" && key.name === "d") return { action: "prune" };
    if (mapView === "path" && key.name === "b") return { action: "bookmark" };
    return { action: "none" };
  }
  // Shifted arrows nudge the viewport one line, for reading past the focused
  // part without moving focus; ctrl+d/u still jump by a screenful.
  if (key.shift && key.name === "down") return { action: "scroll-line-down" };
  if (key.shift && key.name === "up") return { action: "scroll-line-up" };
  if (key.name === "pagedown") return { action: "scroll-down" };
  if (key.name === "pageup") return { action: "scroll-up" };
  if (key.name === "down") return { action: "focus-next" };
  if (key.name === "up") return { action: "focus-previous" };
  if (key.name === "right") return { action: "take-next" };
  if (key.name === "left") return { action: "take-previous" };
  if (key.name === "u") return { action: "undo" };
  if (key.name === "g") return { action: "top" };
  if (key.name === "p") return { action: "toggle-instructions" };
  if (key.name === "return" || key.name === "i") return { action: "compose" };
  if (key.name === "space") return { action: "continue" };
  if (key.name === "n") return { action: "new-item" };
  if (key.name === "c") return { action: "open-chapters" };
  if (key.name === "[") return { action: "chapter-previous" };
  if (key.name === "]") return { action: "chapter-next" };
  if (key.name === "m") return { action: "open-map" };
  if (key.name === "f") return { action: "open-facts" };
  if (key.name === "o") return { action: "open-library" };
  if (key.name === ":") return { action: "open-commands" };
  if (key.name === ",") return { action: "open-settings" };
  if (key.name === "?" || key.sequence === "?") return { action: "open-keys" };
  if (key.name === "d") return { action: "prune" };
  if (key.name === "b") return { action: "bookmark" };
  if (key.name === "y") return { action: "copy-part" };
  if (key.name === "x") return { action: "open-actions" };
  if (key.name === "z") return { action: "typewriter" };
  if (key.name === "e") return { action: "edit" };
  if (key.name === "w") return { action: "write" };
  if (key.name === "r") return { action: "regenerate" };
  if (key.name === "q") return { action: "quit" };
  return { action: "none" };
}
