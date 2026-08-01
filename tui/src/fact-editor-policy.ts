import {
  composerPosition,
  redoComposerEditOwner,
  replaceComposerTextRange,
  resetComposerEditHistory,
  shareComposerEditHistory,
  undoComposerEditOwner,
  type ComposerState
} from "./composer-model.js";
import {
  FactActivationError,
  parseFactKeys
} from "../../shared/fact-activation.js";
import { graphemeCells } from "./cell-width.js";
import { wrappedComposerLayout } from "./composer-wrapping.js";
import { factTagPresets } from "./facts-model.js";
import type { ResolvedKey } from "./keys.js";
import type { FactEditorSession, RuntimeState } from "./state.js";

export const FACT_EDITOR_FOOTER =
  "tab/shift+tab choose · ctrl+t custom · ctrl+s save · esc cancel";
export const FACT_TAG_COMPOSER_SOURCE = "fact-tag";
export const FACT_ACTIVATION_COMPOSER_SOURCE = "fact-activation";
export const FACT_KEYS_COMPOSER_SOURCE = "fact-keys";
export const FACT_BODY_COMPOSER_SOURCE = "fact-body";

const ACTIVATION_TEXT_ACTIONS = new Set<ResolvedKey["action"]>([
  "input", "backspace", "delete-forward", "delete-word-left", "delete-word-right",
  "delete-line", "delete-line-start", "delete-line-end", "paste-clipboard",
  "cut-selection", "select-all", "cursor-word-left", "cursor-word-right",
  "cursor-line-start", "cursor-line-end", "cursor-buffer-start", "cursor-buffer-end"
]);

/** Fact-only editor commands. */
export function handleFactEditorCommand(
  resolved: ResolvedKey,
  state: RuntimeState,
  editor: FactEditorSession
): boolean {
  if (resolved.action === "cycle") {
    if (editor.focus === "activation") {
      cycleFactEditorActivation(editor);
      return true;
    }
    if (editor.focus === "keys") {
      setFactEditorFocus(editor, resolved.index === -1 ? "activation" : "body");
      return true;
    }
    cycleFactEditorTag(state, editor, resolved.index === -1 ? -1 : 1);
    return true;
  }
  if (editor.focus === "activation") {
    if (resolved.action === "cursor-left" || resolved.action === "cursor-right"
      || resolved.action === "newline") {
      cycleFactEditorActivation(editor);
      return true;
    }
    if (ACTIVATION_TEXT_ACTIONS.has(resolved.action)) {
      state.toast = "use left or right to select Fact activation";
      return true;
    }
  }
  if (resolved.action === "edit-tag") {
    selectFactEditorTag(state, editor);
    return true;
  }
  return false;
}

/** Tab walks presets and saved custom tags, then returns input to the body. */
export function cycleFactEditorTag(
  state: RuntimeState,
  editor: FactEditorSession,
  direction: -1 | 1
): void {
  disarmFactEditor(editor);
  const current = factEditorTag(editor);
  const options = factTagPresets(state.payload.facts, current);
  const at = Math.max(0, options.indexOf(current));
  replaceTagText(
    editor,
    options[(at + direction + options.length) % options.length] ?? null
  );
  setFactEditorFocus(editor, "body");
}

/** Ctrl+T selects the typed tag field for custom entry. */
export function selectFactEditorTag(
  state: RuntimeState,
  editor: FactEditorSession
): void {
  disarmFactEditor(editor);
  setFactEditorFocus(editor, "tag");
  editor.tag.anchor = 0;
  editor.tag.cursor = tagLength(editor.tag.text);
  state.toast = "type a custom tag · saved tags join this slider";
}

/** Centralize Fact editor focus changes and clear sibling selection/cut ownership. */
export function setFactEditorFocus(
  editor: FactEditorSession,
  focus: FactEditorSession["focus"]
): void {
  editor.focus = focus;
  if (focus !== "tag") {
    editor.tag.anchor = null;
    editor.tagCutConfirmation = null;
  }
  if (focus !== "keys") {
    editor.keys.anchor = null;
    editor.keysCutConfirmation = null;
  }
  if (focus !== "body") {
    editor.composer.anchor = null;
    editor.cutConfirmation = null;
  }
}

/** Keep the tag and key fields on one line. */
export function factEditorInsert(
  editor: FactEditorSession,
  raw: string,
  source: "paste" | "input" | "newline"
): { text: string } | { blocked: string } {
  if (editor.focus === "body") return { text: raw };
  if (editor.focus === "activation") {
    return { blocked: "use left or right to select Fact activation" };
  }
  if (source === "newline" || /^[\r\n\u2028\u2029]+$/u.test(raw)) {
    return { blocked: editor.focus === "tag"
      ? "fact tags stay on one line"
      : "fact keys stay on one line" };
  }
  return {
    text: raw.replace(/[\r\n\u2028\u2029]+/gu, " ")
  };
}

export function factEditorActiveComposer(
  editor: FactEditorSession
): ComposerState {
  if (editor.focus === "tag") return editor.tag;
  if (editor.focus === "keys" || editor.focus === "activation") return editor.keys;
  return editor.composer;
}

/** Resolve generic projected source identity at the Fact editor boundary. */
export function factEditorComposerForSource(
  editor: FactEditorSession,
  sourceId: string | undefined
): ComposerState | null {
  if (sourceId === FACT_TAG_COMPOSER_SOURCE) {
    setFactEditorFocus(editor, "tag");
    return editor.tag;
  }
  if (sourceId === FACT_ACTIVATION_COMPOSER_SOURCE) {
    setFactEditorFocus(editor, "activation");
    return null;
  }
  if (sourceId === FACT_KEYS_COMPOSER_SOURCE) {
    setFactEditorFocus(editor, "keys");
    return editor.keys;
  }
  if (sourceId === FACT_BODY_COMPOSER_SOURCE) {
    setFactEditorFocus(editor, "body");
    return editor.composer;
  }
  return sourceId === undefined ? factEditorActiveComposer(editor) : null;
}

export function factEditorSelectionMessage(
  kind: "mixed" | "uneditable"
): string {
  return kind === "mixed"
    ? "select the Fact tag, keys, or text"
    : "Fact choices use their row controls";
}

/** Undo and redo follow the shared bounded delta journal. */
export function handleFactEditorHistory(
  resolved: ResolvedKey,
  state: RuntimeState,
  editor: FactEditorSession
): boolean {
  if (resolved.action !== "undo-edit" && resolved.action !== "redo-edit") {
    return false;
  }
  const redo = resolved.action === "redo-edit";
  const owner = redo
    ? redoComposerEditOwner(editor.composer)
    : undoComposerEditOwner(editor.composer);
  if (owner === null) {
    state.toast = redo ? "nothing to redo" : "nothing to undo";
    return true;
  }
  setFactEditorFocus(editor,
    owner === editor.tag ? "tag" : owner === editor.keys ? "keys" : "body");
  disarmFactEditor(editor);
  return true;
}

/** Link the editable Fact fields to one bounded delta journal. */
export function initializeFactEditorHistory(
  editor: Pick<FactEditorSession, "tag" | "keys" | "composer">
): void {
  shareComposerEditHistory([editor.tag, editor.keys, editor.composer]);
}

/** Reset the composite journal after an authoritative buffer replacement. */
export function resetFactEditorHistory(editor: FactEditorSession): void {
  resetComposerEditHistory(editor.tag);
  resetComposerEditHistory(editor.keys);
  resetComposerEditHistory(editor.composer);
}

/** Share cut-confirmation ownership while the active Fact field changes. */
export function factEditorBuffer(editor: FactEditorSession): {
  composer: ComposerState;
  cutConfirmation: FactEditorSession["cutConfirmation"];
} {
  return {
    composer: factEditorActiveComposer(editor),
    get cutConfirmation() {
      return editor.focus === "tag"
        ? editor.tagCutConfirmation
        : editor.focus === "keys" || editor.focus === "activation"
          ? editor.keysCutConfirmation
        : editor.cutConfirmation;
    },
    set cutConfirmation(value) {
      if (editor.focus === "tag") editor.tagCutConfirmation = value;
      else if (editor.focus === "keys" || editor.focus === "activation") {
        editor.keysCutConfirmation = value;
      }
      else editor.cutConfirmation = value;
    }
  };
}

/** Move through the Fact fields and the first body visual row. */
export function handleFactEditorVerticalMove(
  resolved: ResolvedKey,
  editor: FactEditorSession,
  wrapWidth: number
): boolean {
  if (resolved.action !== "cursor-up" && resolved.action !== "cursor-down") {
    return false;
  }
  if (editor.focus === "tag") {
    if (resolved.action === "cursor-down") {
      setFactEditorFocus(editor, "activation");
    }
    return true;
  }
  if (editor.focus === "activation") {
    setFactEditorFocus(editor, resolved.action === "cursor-up" ? "tag" : "keys");
    return true;
  }
  if (editor.focus === "keys") {
    if (resolved.action === "cursor-up") setFactEditorFocus(editor, "activation");
    else setFactEditorFocus(editor, "body");
    return true;
  }
  const layout = wrappedComposerLayout(editor.composer, wrapWidth);
  if (resolved.action === "cursor-up" && layout.cursorRow === 0) {
    setFactEditorFocus(editor, "keys");
    editor.keys.anchor = null;
    editor.keys.cursor = Math.min(
      tagLength(editor.keys.text),
      composerPosition(editor.composer).column
    );
    return true;
  }
  return false;
}

export function factEditorTag(editor: FactEditorSession): string | null {
  const tag = editor.tag.text.trim();
  return tag.length === 0 ? null : tag;
}

export function factEditorTagLabel(editor: FactEditorSession): string {
  return factEditorTag(editor)?.replace(/[\r\n\u2028\u2029]+/gu, "↵") ?? "none";
}

export function factEditorChanged(editor: FactEditorSession): boolean {
  return factEditorTagChanged(editor)
    || editor.activation !== editor.initialFact.activation
    || factEditorKeysChanged(editor)
    || editor.composer.text !== editor.initialFact.text;
}

/** Preserve the stored tag until the writer changes the tag field. */
export function factEditorPersistedTag(editor: FactEditorSession): string | null {
  return factEditorTagChanged(editor)
    ? factEditorTag(editor)
    : editor.initialFact.tag;
}

export function factEditorSavePayload(
  editor: FactEditorSession
): { ok: true; tag: string | null; activation: FactEditorSession["activation"];
  keys: string[]; text: string } | { ok: false; toast: string } {
  if (editor.composer.text.trim().length === 0) {
    return { ok: false, toast: "fact text cannot be empty" };
  }
  const parsedKeys = factEditorKeys(editor);
  if (!parsedKeys.ok) return parsedKeys;
  return {
    ok: true,
    tag: factEditorPersistedTag(editor),
    activation: editor.activation,
    keys: factEditorKeysChanged(editor) ? parsedKeys.keys : [...editor.initialFact.keys],
    text: editor.composer.text
  };
}

export function formatFactKeys(keys: readonly string[]): string {
  return keys.join(", ");
}

function factEditorTagChanged(editor: FactEditorSession): boolean {
  return editor.tag.text !== (editor.initialFact.tag ?? "");
}

function factEditorKeysChanged(editor: FactEditorSession): boolean {
  return editor.keys.text !== formatFactKeys(editor.initialFact.keys);
}

function factEditorKeys(
  editor: FactEditorSession
): { ok: true; keys: string[] } | { ok: false; toast: string } {
  if (editor.keys.text.trim().length === 0) return { ok: true, keys: [] };
  const keys = editor.keys.text.split(",").map((key) => key.trim());
  if (keys.some((key) => key.length === 0)) {
    return { ok: false, toast: "fact keys cannot contain an empty entry" };
  }
  try {
    return { ok: true, keys: parseFactKeys(keys) };
  } catch (error) {
    if (error instanceof FactActivationError) {
      return { ok: false, toast: error.message };
    }
    throw error;
  }
}

function cycleFactEditorActivation(editor: FactEditorSession): void {
  disarmFactEditor(editor);
  editor.activation = editor.activation === "always" ? "keyed" : "always";
}

function replaceTagText(
  editor: FactEditorSession,
  tag: string | null
): void {
  const text = tag ?? "";
  replaceComposerTextRange(
    editor.tag,
    0,
    tagLength(editor.tag.text),
    text,
    { cursor: tagLength(text), anchor: null }
  );
}

function tagLength(text: string): number {
  return graphemeCells(text).length;
}

function disarmFactEditor(editor: FactEditorSession): void {
  if (editor.conflict !== null) editor.conflict.armed = false;
  editor.cutConfirmation = null;
  editor.tagCutConfirmation = null;
  editor.keysCutConfirmation = null;
}
