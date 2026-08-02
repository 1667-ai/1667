import type { StoryFact } from "../../shared/types.js";
import { resolveAuthorsNoteDepth } from "../../shared/authors-note.js";
import { setComposerText } from "./composer-model.js";
import {
  factEditorChanged,
  formatFactKeys,
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
  const target = editor.target;
  const authoritative = state.payload.authorsNote ?? "";
  const authoritativeDepth = resolveAuthorsNoteDepth(state.payload.authorsNoteDepth);
  // A depth draft the writer never touched rebases quietly; one they changed
  // stays their own, the same way a pristine vs. dirty text draft behaves.
  const depthPristine = target.depth === target.expectedDepth;
  target.expectedDepth = authoritativeDepth;
  if (depthPristine) target.depth = authoritativeDepth;
  target.expected = authoritative;
  // A depth the writer moved while the authority moved it elsewhere is the
  // same standoff as two texts that disagree, and it earns the same
  // confirmation. Without this the draft would save over the recovered depth
  // with no warning, because the text alone still matches.
  reconcileEditorDocument(
    state,
    editor,
    authoritative,
    "Author's Note changed during recovery",
    target.depth === authoritativeDepth
  );
}

/** Reconcile an authoritative Author Brief refresh against the active draft. */
export function reconcileAuthorBriefEditor(state: RuntimeState): void {
  const editor = state.editor;
  if (editor?.kind !== "document" || editor.target.kind !== "author-brief") return;
  const authoritative = state.payload.authorBrief ?? "";
  editor.target.expected = authoritative;
  // The brief is one field: its text is the whole draft.
  reconcileEditorDocument(state, editor, authoritative, "Author Brief changed during recovery", true);
}

function reconcileFactDocument(
  state: RuntimeState,
  editor: FactEditorSession,
  current: StoryFact,
  message: string
): void {
  const draftMatches = factEditorPersistedTag(editor) === current.tag
    && editor.activation === current.activation
    && editor.keys.text === formatFactKeys(current.keys)
    && editor.composer.text === current.text;
  if (draftMatches) {
    editor.initialFact = editableFact(current);
    editor.conflict = null;
    return;
  }
  if (!factEditorChanged(editor)) {
    setComposerText(editor.tag, current.tag ?? "");
    editor.activation = current.activation;
    setComposerText(editor.keys, formatFactKeys(current.keys));
    setComposerText(editor.composer, current.text);
    resetFactEditorHistory(editor);
    editor.initialFact = editableFact(current);
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

/** `otherFieldsMatch` reports whether every field beyond the text agrees with
 * the authoritative story. Each caller states it, because a target that gains
 * a field must not reconcile on its text alone. */
function reconcileEditorDocument(
  state: RuntimeState,
  editor: InlineEditorSession,
  authoritative: string,
  message: string,
  otherFieldsMatch: boolean
): void {
  if (editor.composer.text === authoritative && otherFieldsMatch) {
    editor.initial = authoritative;
    editor.conflict = null;
    return;
  }
  if (editor.composer.text === editor.initial && otherFieldsMatch) {
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
  return left !== null
    && left.id === right.id
    && left.tag === right.tag
    && left.activation === right.activation
    && left.keys.length === right.keys.length
    && left.keys.every((key, index) => key === right.keys[index])
    && left.text === right.text;
}

function editableFact(
  fact: StoryFact
): Pick<StoryFact, "tag" | "activation" | "keys" | "text"> {
  return {
    tag: fact.tag,
    activation: fact.activation,
    keys: [...fact.keys],
    text: fact.text
  };
}
