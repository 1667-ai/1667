import type { KeyEvent } from "@opentui/core";
import { insertComposerText, type ComposerState } from "./composer-model.js";
import {
  editorInsertionPolicy,
  insertEditorText
} from "./editor-text-insertion.js";
import { globalEditor } from "./editor-scope.js";
import {
  factEditorBuffer
} from "./fact-editor-policy.js";
import { textSurfaceKey } from "./keys-text-surface.js";
import { openDirectComposer } from "./composer-ownership.js";
import type { MapView } from "./map-state.js";
import { resolveReferenceBinding } from "./reference-bindings.js";
import type { StorySelectionSpan } from "./selection-projection.js";
import type {
  DocumentEditorSession,
  PendingGenerationDraft,
  RetakePromptSession,
  RuntimeState,
  SettingsInlineEditState,
  SettingsRowId
} from "./state.js";
import { setLibraryQuery } from "./library-model.js";
import type { StorySummary } from "../../shared/types.js";

export type KeyAction =
  | "focus-next" | "focus-previous" | "take-next" | "take-previous" | "take-at"
  | "undo" | "top" | "leaf" | "toggle-instructions" | "toggle-prompt" | "compose"
  | "cancel" | "quit" | "send" | "newline" | "history-previous"
  | "save-edit" | "save-edit-inplace" | "commit-field"
  | "history-next" | "backspace" | "input" | "none" | "open-map"
  | "cycle-map-view" | "toggle-path-takes" | "toggle-sketches" | "map-follow" | "map-cycle-sort"
  | "set-map-view"
  | "cursor-left" | "cursor-right" | "cursor-up" | "cursor-down" | "toggle-compose-fullscreen"
  | "cursor-word-left" | "cursor-word-right"
  | "cursor-line-start" | "cursor-line-end"
  | "cursor-buffer-start" | "cursor-buffer-end"
  | "delete-forward" | "delete-word-left" | "delete-word-right" | "delete-line"
  | "delete-line-start" | "delete-line-end" | "select-all"
  | "copy-selection" | "cut-selection" | "paste-clipboard" | "undo-edit" | "redo-edit"
  | "edit-tag"
  | "open-keys" | "prune" | "tag" | "delete-tag"
  | "typewriter" | "edit" | "write" | "regenerate" | "retake-with-prompt" | "apply"
  | "open-library" | "open-facts" | "open-commands" | "open-settings"
  | "open-selected" | "new-item" | "rename-item" | "delete-item"
  | "open-authors-note"
  | "filter" | "cycle" | "check" | "detect-context" | "discard-pending" | "retry" | "continue"
  | "scroll-down" | "scroll-up" | "scroll-line-down" | "scroll-line-up" | "toggle-rail" | "copy-part" | "copy-line" | "open-actions" | "focus-index"
  | "open-chapters" | "create-chapter" | "summarize-chapter" | "chapter-previous" | "chapter-next"
  | "toggle-context-meter" | "open-search" | "toggle-search-case";

export type AppMode = "NAV" | "COMPOSE" | "EDITOR" | "MAP" | "KEYS" | "TAG"
  | "LIBRARY" | "FACTS" | "COMMANDS" | "SUMMARY" | "SETTINGS" | "ACTIONS" | "CHAPTERS"
  | "SEARCH";

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
  /** Stable row identity for deferred list and prose clicks. */
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
  "prune", "apply", "delete-tag", "edit", "write", "regenerate", "tag",
  "new-item", "rename-item", "delete-item", "discard-pending",
  "create-chapter", "summarize-chapter", "open-authors-note", "save-edit", "save-edit-inplace"
]);

/** Global-scope editor saves update local application state, not the story. */
export function actionConflictsWithGeneration(
  action: KeyAction,
  state: Pick<RuntimeState, "mode" | "editor">
): boolean {
  if ((action === "save-edit" || action === "save-edit-inplace")
    && globalEditor(state) !== null) {
    return false;
  }
  return MUTATING_ACTIONS.has(action);
}

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

/** OpenTUI delivers raw LF / Ctrl+J as name `linefeed` with sequence newline.
 *  That must resolve as `newline`, never as single-character `input`. */
function isLinefeedKey(key: KeyEvent): boolean {
  const name = key.name.toLowerCase();
  if (name === "linefeed") return true;
  // Some terminals keep the letter name when Ctrl+J produces a linefeed.
  if (key.ctrl && !key.meta && name === "j") return true;
  return false;
}

function textInput(key: KeyEvent): ResolvedKey | null {
  if (!key.ctrl && !key.meta && key.sequence.length > 0 && [...key.sequence].length === 1) {
    // Line terminators are structural, not text. Multline surfaces map them to
    // `newline` first; single-line surfaces must not inject them either.
    if (/[\r\n\u2028\u2029]/u.test(key.sequence)) return null;
    return { action: "input", text: key.sequence };
  }
  return null;
}

function composerBackedInput(key: KeyEvent): ResolvedKey {
  return textSurfaceKey(key) ?? textInput(key) ?? { action: "none" };
}

function multilineInput(key: KeyEvent): ResolvedKey {
  if (key.name === "up" || key.name === "down") {
    return {
      action: key.name === "up" ? "cursor-up" : "cursor-down",
      ...(key.shift ? { extendSelection: true } : {})
    };
  }
  return composerBackedInput(key);
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
    editor: DocumentEditorSession | null;
    toast?: string | null;
    tag: { choosingStatus: boolean; name: string } | null;
    library: {
      stories: StorySummary[];
      cursor: number;
      query: string;
      prompt:
        | { kind: "filter" }
        | { kind: "rename" | "delete"; value: string }
        | null;
    } | null;
    facts: { filtering: boolean; query: string; cursor: number } | null;
    commands: { view: string; query: string } | null;
    search: { query: string } | null;
    chapters?: { rename: { value: string } | null } | null;
    settings: {
      edit: SettingsInlineEditState | null;
      conflict: { armed: boolean } | null;
    } | null;
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
  if (state.mode === "EDITOR") {
    const editor = state.editor;
    if (editor === null) return false;
    const buffer = editor.kind === "fact" ? factEditorBuffer(editor) : editor;
    insertEditorText(
      state,
      buffer,
      editorInsertionPolicy(editor),
      clean,
      "paste"
    );
    return true;
  }
  if (state.mode === "COMPOSE") { insertComposerText(state.composer, clean); return true; }
  if (state.mode === "TAG" && state.tag !== null && !state.tag.choosingStatus) {
    state.tag.name += line;
    return true;
  }
  if (state.mode === "LIBRARY" && state.library?.prompt != null) {
    if (state.library.prompt.kind === "filter") {
      setLibraryQuery(state.library, state.library.query + line);
    } else {
      state.library.prompt.value += line;
    }
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
  if (state.mode === "SEARCH" && state.search !== null) {
    return false;
  }
  const chapterRename = state.mode === "CHAPTERS" ? state.chapters?.rename : null;
  if (chapterRename != null) {
    chapterRename.value += line;
    return true;
  }
  const settingsEdit = state.mode === "SETTINGS" ? state.settings?.edit : null;
  if (settingsEdit?.kind === "inline") {
    if (state.settings?.conflict != null) state.settings.conflict.armed = false;
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
  tagChoosingStatus?: boolean;
  connectionDown?: boolean;
  /** A text prompt/filter owns the keyboard: letters are input, not hotkeys. */
  overlayTyping?: boolean;
  /** The command palette is showing its tags sub-view. */
  commandsTags?: boolean;
  /** The full-screen editor owns a Fact tag slider above its text body. */
  factEditor?: boolean;
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
  // Search refines live, so its query field owns every plain letter. Its own
  // verbs are arrows and chords for exactly that reason.
  return mode === "COMPOSE" || mode === "EDITOR" || mode === "SEARCH"
    || options.overlayTyping === true
    || mode === "COMMANDS" && options.commandsTags !== true
    || mode === "TAG" && options.tagChoosingStatus !== true;
}

export function resolveKey(key: KeyEvent, mode: AppMode, options: ResolveOptions = {}): ResolvedKey {
  const { confirmingPrune = false, tagChoosingStatus = false, connectionDown = false,
    overlayTyping = false, commandsTags = false, factEditor = false,
    mapView = "path" } = options;
  const globalReference = resolveReferenceBinding("global", key, mode, mapView);
  if (globalReference !== null || key.name === "escape") {
    return { action: "cancel" };
  }
  const ownsText = textOwnsKeyboard(mode, {
    overlayTyping, commandsTags, tagChoosingStatus
  });
  // The banner's capital-R shortcut is page/list chrome, never a text-field
  // override. Writers must still be able to type R while working offline.
  if (!key.ctrl && !key.meta && connectionDown && !ownsText && shiftedLetter(key, "r")) {
    return { action: "retry" };
  }
  if (confirmingPrune) {
    return { action: key.name === "d" && !key.ctrl && !key.meta && !key.shift ? "prune" : "none" };
  }
  const shiftedReference = resolveReferenceBinding("nav-shifted", key, mode, mapView);
  if (shiftedReference !== null) return { action: shiftedReference.action };
  // Capital letters are distinct terminal commands. Declared reference routes
  // resolve above; reject every other shifted spelling so lowercase-name
  // terminal events cannot silently trigger lowercase hotkeys.
  if (!ownsText && shiftedAsciiLetter(key)) return { action: "none" };
  const navChord = resolveReferenceBinding("nav-chord", key, mode, mapView);
  if (navChord !== null) return { action: navChord.action };
  if (mode === "COMPOSE") {
    const composeChord = resolveReferenceBinding("compose-chord", key, mode, mapView);
    if (composeChord !== null) return { action: composeChord.action };
    if (key.ctrl && key.name.toLowerCase() === "f") return { action: "toggle-compose-fullscreen" };
    if (key.name === "return") return { action: key.shift ? "newline" : "send" };
    // LF / Ctrl+J inserts a line; it never sends the draft.
    if (isLinefeedKey(key)) return { action: "newline" };
    return multilineInput(key);
  }
  if (mode === "EDITOR") {
    const name = key.name.toLowerCase();
    if (factEditor && key.name === "tab") {
      return { action: "cycle", index: key.shift ? -1 : 1 };
    }
    if (factEditor && key.ctrl && name === "t") return { action: "edit-tag" };
    // Plain ctrl+s forks a take. Same-take save needs a chord that classic
    // terminals can deliver: ctrl+s and ctrl+shift+s both arrive as 0x13
    // without enhanced keyboard reporting, so ctrl+o is the portable path.
    // ctrl+shift+s remains for terminals that can report the shift bit.
    if (key.ctrl && name === "o") return { action: "save-edit-inplace" };
    if (key.ctrl && key.shift && name === "s") return { action: "save-edit-inplace" };
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
    // The editor's own chords: emacs character motion, and ctrl+d forward
    // delete. Everything else it shares with Direct and the settings fields.
    if (key.ctrl && (name === "b" || name === "f")) {
      return {
        action: name === "b" ? "cursor-left" : "cursor-right",
        ...(key.shift ? { extendSelection: true } : {})
      };
    }
    if (key.name === "return" || isLinefeedKey(key)) return { action: "newline" };
    if (key.name === "up" || key.name === "down") {
      return {
        action: key.name === "up" ? "cursor-up" : "cursor-down",
        ...(key.shift ? { extendSelection: true } : {})
      };
    }
    if (key.ctrl && name === "d") return { action: "delete-forward" };
    return composerBackedInput(key);
  }
  if (mode === "SETTINGS" && overlayTyping) {
    const name = key.name.toLowerCase();
    if (key.name === "return" || key.ctrl && name === "s") return { action: "commit-field" };
    if ((key.ctrl || key.super) && name === "v") return { action: "paste-clipboard" };
    if (key.super && name === "a") return { action: "select-all" };
    // A settings field holds a base URL. It edits like every other surface.
    return composerBackedInput(key);
  }
  if (mode === "SETTINGS"
    && (key.ctrl || key.super)
    && key.name.toLowerCase() === "v") {
    return { action: "paste-clipboard" };
  }
  if (mode === "SEARCH") {
    const searchReference = resolveReferenceBinding("search", key, mode, mapView);
    if (searchReference !== null) return { action: searchReference.action };
    if (key.name === "backspace") return { action: "backspace" };
    return textInput(key) ?? { action: "none" };
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
  // The reference can outgrow a short terminal, so it scrolls with the same
  // vocabulary every other overlay uses — which also gives it the mouse wheel,
  // since `mouseToAction` sends wheel gestures over any overlay as focus moves.
  if (mode === "KEYS") {
    if (key.name === "down") return { action: "focus-next" };
    if (key.name === "up") return { action: "focus-previous" };
    if (key.name === "pagedown" || key.name === "space") return { action: "scroll-down" };
    if (key.name === "pageup") return { action: "scroll-up" };
    return { action: "none" };
  }
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
    if (key.name === "return") {
      return { action: mode === "FACTS" && !overlayTyping ? "edit" : "open-selected" };
    }
    if (key.name === "backspace") return { action: "backspace" };
    if (key.name === "down") return { action: "focus-next" };
    if (key.name === "up") return { action: "focus-previous" };
    if (!overlayTyping) {
      if (mode !== "COMMANDS" && key.name === "/") return { action: "filter" };
      if (mode !== "COMMANDS" && key.name === "n") return { action: "new-item" };
      // One verb per gesture across every list: `e` opens the selected row,
      // `d` deletes it. Facts and the tag manager used to delete on `x`
      // while the library and chapters deleted on `d`.
      if (mode === "LIBRARY" && key.name === "e") return { action: "rename-item" };
      if (mode === "FACTS" && key.name === "e") return { action: "edit" };
      if (key.name === "d" && (mode === "LIBRARY" || mode === "FACTS"
        || mode === "COMMANDS" && commandsTags)) return { action: "delete-item" };
    }
    if (mode === "FACTS" && key.name === "tab") return { action: "cycle" };
    return textInput(key) ?? { action: "none" };
  }
  if (mode === "TAG") {
    if (key.name === "return") return { action: "apply" };
    if (tagChoosingStatus && key.name === "left") return { action: "take-previous" };
    if (tagChoosingStatus && key.name === "right") return { action: "take-next" };
    if (key.name === "backspace") return { action: "backspace" };
    if (tagChoosingStatus && key.name === "d") return { action: "delete-tag" };
    return textInput(key) ?? { action: "none" };
  }
  if (mode === "MAP") {
    const mapReference = resolveReferenceBinding("map", key, mode, mapView);
    return { action: mapReference?.action ?? "none" };
  }
  const navReference = resolveReferenceBinding("nav", key, mode, mapView);
  return { action: navReference?.action ?? "none" };
}
