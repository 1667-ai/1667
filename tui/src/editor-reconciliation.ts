import type { StoryFact } from "../../shared/types.js";
import { factDraftOf, sameFactDraft } from "../../shared/fact-draft.js";
import {
  canonicalFactStates,
  isFactEndState,
  isFactStateful,
  sameFactStateValue,
  type FactState
} from "../../shared/fact-state.js";
import { resolveAuthorsNoteDepth } from "../../shared/authors-note.js";
import { setComposerText } from "./composer-model.js";
import {
  applyFactDraftToEditor,
  factDraftFromEditor,
  factEditorChanged,
  factEditorMetadataChanged
} from "./fact-editor-draft.js";
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
  if (editor.stateCursorAnchorId !== undefined
    && editor.stateCursorAnchorId !== null
    && !state.payload.nodes.some(({ id, role }) =>
      id === editor.stateCursorAnchorId && role !== "summary")) {
    // A cursor row can disappear while the editor remains open. A stale id
    // must not leave a re-anchor action that could turn an anchored state into
    // an accidental unanchor.
    editor.stateCursorAnchorId = null;
  }
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
  if (sameEditableFact(editor.target.base, current, editor)) {
    // A non-selected state may have changed. Keep the authoritative Fact as
    // the next save baseline while leaving this editor's selected-state draft
    // and conflict state untouched.
    editor.target.base = current;
    return;
  }
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
  const stateful = hasSelectedState(editor);
  const selectedState = stateful ? selectedStateForFact(current, editor) : undefined;
  if (stateful && selectedState === undefined) {
    recoverDeletedSelectedState(state, editor, current, message);
    return;
  }
  const draft = selectedState === undefined
    ? factDraftOf(current)
    : factDraftForSelectedState(current, selectedState);
  // "Does the live editor already show exactly this Fact" goes through the
  // same FactDraft equality every other Fact comparison in the app uses
  // (see shared/fact-draft.ts), rather than a field-by-field compare hand-
  // listed here a third time — issue #281 review finding A. An editor whose
  // buffers do not currently parse to any FactDraft (empty body, an invalid
  // keys or budget entry) plainly is not already showing this one.
  const liveDraft = factDraftFromEditor(editor);
  const nameMatches = editor.name === undefined
    || editor.name.text === (current.name ?? "");
  const draftMatches = liveDraft !== null && nameMatches && sameFactDraft(liveDraft, draft);
  if (draftMatches) {
    if (editor.name !== undefined) {
      editor.name.text = current.name ?? "";
      editor.initialName = current.name ?? null;
    }
    if (selectedState !== undefined) rebaseSelectedState(editor, current, selectedState);
    editor.initialFact = draft;
    editor.conflict = null;
    return;
  }
  if (!factEditorChanged(editor)) {
    applyFactDraftToEditor(editor, draft);
    if (editor.name !== undefined) {
      editor.name.text = current.name ?? "";
      editor.initialName = current.name ?? null;
    }
    if (selectedState !== undefined) rebaseSelectedState(editor, current, selectedState);
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

/** Keep a selected-state draft useful when recovery removes its persisted
 * target. The Fact still exists, so the draft becomes a new state under the
 * current Fact. Rebase only Fact-wide fields the writer did not change. */
function recoverDeletedSelectedState(
  state: RuntimeState,
  editor: FactEditorSession,
  current: StoryFact,
  message: string
): void {
  const metadataPristine = !factEditorMetadataChanged(editor);
  const localText = editor.composer.text;
  const localEnds = editor.stateIsEnd === true;
  const localAnchor = editor.stateAnchorPartId ?? null;

  if (metadataPristine) {
    const rebased = { ...factDraftOf(current), text: localText };
    applyFactDraftToEditor(editor, rebased);
    editor.initialFact = rebased;
    editor.initialName = current.name ?? null;
    resetFactEditorHistory(editor);
  }

  editor.stateCreating = true;
  editor.stateId = null;
  editor.stateInitialId = null;
  editor.stateIndex = canonicalFactStates(current).length;
  editor.stateIsEnd = localEnds;
  editor.stateInitialEnds = false;
  editor.stateInitialText = "";
  editor.stateAnchorPartId = localAnchor;
  editor.stateInitialAnchorPartId = localAnchor;
  editor.stateDeleteArmedId = null;
  // The deleted target is no longer a conflict. The next save creates the
  // preserved draft instead of asking for a second confirmation or PATCHing
  // the vanished id.
  editor.conflict = null;
  editor.title = "new fact state · recovered draft";
  state.toast = `${message} · selected state deleted · draft kept as a new state`;
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
function sameEditableFact(
  left: StoryFact | null,
  right: StoryFact,
  editor: FactEditorSession
): boolean {
  if (left === null || left.id !== right.id) return false;
  if (!hasSelectedState(editor)) {
    return left.name === right.name
      && sameFactDraft(factDraftOf(left), factDraftOf(right));
  }
  const leftState = selectedStateForFact(left, editor);
  const rightState = selectedStateForFact(right, editor);
  // State identity is part of the baseline. A state that disappeared or was
  // replaced must not look unchanged merely because the first state matches.
  return leftState !== undefined
    && rightState !== undefined
    && sameFactStateValue(leftState, rightState)
    && sameFactDraft(
      factDraftForSelectedState(left, leftState),
      factDraftForSelectedState(right, rightState)
    );
}

/** Whether this editor has a persisted state selection. A state-creation
 * draft has no selected state to rebase until its create mutation succeeds. */
function hasSelectedState(editor: FactEditorSession): boolean {
  if (editor.stateCreating === true) return false;
  const fact = editor.target.base;
  return editor.stateId !== undefined
    || editor.stateInitialId !== undefined
    || fact !== null && isFactStateful(fact);
}

function selectedStateForFact(
  fact: StoryFact,
  editor: FactEditorSession
): FactState | undefined {
  const states = canonicalFactStates(fact);
  const selectedId = editor.stateId ?? editor.stateInitialId;
  if (selectedId !== undefined && selectedId !== null) {
    return states.find(({ id }) => id === selectedId);
  }
  return states[editor.stateIndex ?? 0];
}

/** Project the authoritative Fact metadata with the selected state's value.
 * `factDraftOf` is correct for legacy one-state Facts, but its text is the
 * first state and is never the state-editor baseline. */
function factDraftForSelectedState(
  fact: StoryFact,
  selectedState: FactState
): ReturnType<typeof factDraftOf> {
  const draft = factDraftOf(fact);
  return {
    ...draft,
    text: isFactEndState(selectedState) ? "" : selectedState.text
  };
}

export interface FactStateRebaseOverrides {
  /** Keep a newer local anchor while rebasing the authoritative baseline. */
  anchorPartId?: string | null;
  /** Keep a newer local text/End choice while rebasing the authoritative baseline. */
  stateIsEnd?: boolean;
}

export function rebaseSelectedState(
  editor: FactEditorSession,
  fact: StoryFact,
  selectedState: FactState,
  overrides: FactStateRebaseOverrides = {}
): void {
  const authoritativeAnchorPartId = selectedState.anchorPartId ?? null;
  const authoritativeStateIsEnd = isFactEndState(selectedState);
  editor.stateId = selectedState.id;
  editor.stateInitialId = selectedState.id;
  editor.stateIndex = canonicalFactStates(fact).findIndex(({ id }) => id === selectedState.id);
  editor.stateAnchorPartId = overrides.anchorPartId === undefined
    ? authoritativeAnchorPartId
    : overrides.anchorPartId;
  editor.stateInitialAnchorPartId = authoritativeAnchorPartId;
  editor.stateIsEnd = overrides.stateIsEnd === undefined
    ? authoritativeStateIsEnd
    : overrides.stateIsEnd;
  editor.stateInitialEnds = authoritativeStateIsEnd;
  editor.stateInitialText = authoritativeStateIsEnd ? "" : selectedState.text;
}
