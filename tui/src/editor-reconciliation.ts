import type { StoryFact } from "../../shared/types.js";
import { factDraftOf, sameFactDraft } from "../../shared/fact-draft.js";
import { resolveAuthorsNoteDepth } from "../../shared/authors-note.js";
import { setComposerText } from "./composer-model.js";
import { applyFactDraftToEditor, factDraftFromEditor, factEditorChanged } from "./fact-editor-draft.js";
import { resetFactEditorHistory } from "./fact-editor-policy.js";
import { storyScalarFieldSpec } from "./story-scalar-fields.js";
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

/** Reconcile an authoritative story-scalar refresh (Author Brief, the Facts
 *  budget — see story-scalar-fields.ts) against the active draft. One
 *  reconciler for every field in STORY_SCALAR_FIELDS, table-driven the same
 *  way opening and saving are — each field is one field, so its text is
 *  always the whole draft. */
export function reconcileStoryScalarEditor(state: RuntimeState): void {
  const editor = state.editor;
  if (editor?.kind !== "document" || editor.target.kind !== "story-scalar") return;
  const target = editor.target;
  const spec = storyScalarFieldSpec(target.field);
  const authoritative = spec.read(state.payload);
  target.expected = authoritative;
  reconcileEditorDocument(state, editor, authoritative, `${spec.title} changed during recovery`, true);
}

function reconcileFactDocument(
  state: RuntimeState,
  editor: FactEditorSession,
  current: StoryFact,
  message: string
): void {
  const draft = factDraftOf(current);
  // "Does the live editor already show exactly this Fact" goes through the
  // same FactDraft equality every other Fact comparison in the app uses
  // (see shared/fact-draft.ts), rather than a field-by-field compare hand-
  // listed here a third time — issue #281 review finding A. An editor whose
  // buffers do not currently parse to any FactDraft (empty body, an invalid
  // keys or budget entry) plainly is not already showing this one.
  const liveDraft = factDraftFromEditor(editor);
  const draftMatches = liveDraft !== null && sameFactDraft(liveDraft, draft);
  if (draftMatches) {
    editor.initialFact = draft;
    editor.conflict = null;
    return;
  }
  if (!factEditorChanged(editor)) {
    applyFactDraftToEditor(editor, draft);
    resetFactEditorHistory(editor);
    editor.initialFact = draft;
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

/** Same Fact record, not just the same draft content — a deleted-then-recreated
 *  Fact with identical fields is still a different `base` to reconcile against. */
function sameEditableFact(left: StoryFact | null, right: StoryFact): boolean {
  return left !== null
    && left.id === right.id
    && sameFactDraft(factDraftOf(left), factDraftOf(right));
}
