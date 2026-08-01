import type { StoryFact } from "../../shared/types.js";
import { setComposerText } from "./composer-model.js";
import {
  factEditorChanged,
  factEditorPersistedTag,
  resetFactEditorHistory
} from "./fact-editor-policy.js";
import type {
  FactEditorSession,
  InlineEditorSession,
  RuntimeState
} from "./state.js";

/** Reconcile an authoritative fact refresh against the active draft. Pristine
 * drafts rebase; dirty drafts stay intact and require an explicit overwrite. */
export function reconcileFactEditor(state: RuntimeState): void {
  const editor = state.editor;
  if (editor?.kind !== "fact" || editor.target.factId === null) return;
  const factId = editor.target.factId;
  const current = state.payload.facts.find(({ id }) => id === factId);
  if (current === undefined) {
    editor.target.factId = null;
    editor.target.base = null;
    editor.title = "new fact · recovered deleted draft";
    editor.conflict = {
      message: "fact deleted during recovery · draft kept as a new fact",
      resolution: "create",
      armed: false
    };
    state.toast = editor.conflict.message;
    return;
  }
  if (sameEditableFact(editor.target.base, current)) return;
  editor.target.base = current;
  reconcileFactDocument(state, editor, current, "fact changed during recovery");
}

/** Reconcile an authoritative Author's Note refresh against the active draft. */
export function reconcileAuthorsNoteEditor(state: RuntimeState): void {
  const editor = state.editor;
  if (editor?.kind !== "document" || editor.target.kind !== "authors-note") return;
  const authoritative = state.payload.authorsNote ?? "";
  editor.target.expected = authoritative;
  reconcileEditorDocument(state, editor, authoritative, "Author's Note changed during recovery");
}

function reconcileFactDocument(
  state: RuntimeState,
  editor: FactEditorSession,
  current: StoryFact,
  message: string
): void {
  const draftMatches = factEditorPersistedTag(editor) === current.tag
    && editor.composer.text === current.text;
  if (draftMatches) {
    editor.initialFact = { tag: current.tag, text: current.text };
    editor.conflict = null;
    return;
  }
  if (!factEditorChanged(editor)) {
    setComposerText(editor.tag, current.tag ?? "");
    setComposerText(editor.composer, current.text);
    resetFactEditorHistory(editor);
    editor.initialFact = { tag: current.tag, text: current.text };
    editor.conflict = null;
    state.toast = `${message} · editor refreshed`;
    return;
  }
  editor.conflict = {
    message: `${message} · draft kept`,
    resolution: "overwrite",
    armed: false
  };
  state.toast = editor.conflict.message;
}

function reconcileEditorDocument(
  state: RuntimeState,
  editor: InlineEditorSession,
  authoritative: string,
  message: string
): void {
  if (editor.composer.text === authoritative) {
    editor.initial = authoritative;
    editor.conflict = null;
    return;
  }
  if (editor.composer.text === editor.initial) {
    setComposerText(editor.composer, authoritative);
    editor.initial = authoritative;
    editor.conflict = null;
    state.toast = `${message} · editor refreshed`;
    return;
  }
  editor.conflict = {
    message: `${message} · draft kept`,
    resolution: "overwrite",
    armed: false
  };
  state.toast = editor.conflict.message;
}

function sameEditableFact(left: StoryFact | null, right: StoryFact): boolean {
  return left !== null && left.id === right.id && left.tag === right.tag && left.text === right.text;
}
