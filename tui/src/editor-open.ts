import type { StoryFact } from "../../shared/types.js";
import { EMPTY_FACT_DRAFT, factDraftOf } from "../../shared/fact-draft.js";
import {
  canonicalFactStates,
  firstFactText,
  isFactEndState,
  resolveFactState
} from "../../shared/fact-state.js";
import { resolveAuthorsNoteDepth } from "../../shared/authors-note.js";
import { createComposer } from "./composer-model.js";
import { formatFactBudget, formatFactKeys, formatFactScanDepth } from "./fact-editor-draft.js";
import { initializeFactEditorHistory } from "./fact-editor-policy.js";
import { serializePart, stripGuidance } from "./editor.js";
import { blockUncertainRootCreation } from "./first-take-guard.js";
import { createStoryViewModel, rowPart } from "./model.js";
import { storyScalarFieldSpec, type StoryScalarField } from "./story-scalar-fields.js";
import type {
  FactEditorSession,
  InlineEditorSession,
  RuntimeState
} from "./state.js";

export {
  openSettingsPasteTarget,
  openSystemPromptEditor,
  openWritingPromptEditor
} from "./settings-prompt-editor.js";

export function openPartEditor(state: RuntimeState, humanSibling: boolean): void {
  const part = rowPart(createStoryViewModel(state.payload), state.focusIndex);
  if (part === null) {
    if (!humanSibling || state.payload.path.length !== 0) return;
    if (blockUncertainRootCreation(state)) return;
    openInlineEditor(state, {
      target: {
        kind: "new-part",
        savedNode: null
      },
      composer: createComposer(""),
      initial: "",
      title: "write first take",
      placeholder: "write prose…",
      returnMode: "NAV",
      conflict: null
    });
    return;
  }
  const initial = humanSibling
    ? ""
    : stripGuidance(serializePart(part.node.instruction, part.node.text));
  openInlineEditor(state, {
    target: humanSibling
      ? { kind: "human-take", node: part.node, pathIndex: part.pathIndex, savedNode: null }
      : { kind: "part", node: part.node, pathIndex: part.pathIndex, savedNode: null },
    composer: createComposer(initial),
    initial,
    title: humanSibling
      ? `write human take · sibling of ¶ ${part.number}`
      : `edit ¶ ${part.number} · optional ≻ direction block`,
    placeholder: humanSibling ? "write the sibling take…" : "write prose…",
    returnMode: "NAV",
    conflict: null
  });
}

export interface FactEditorOpenOptions {
  stateId?: string | null;
  anchorPartId?: string | null;
  stateCreating?: boolean;
  returnMode?: "NAV" | "FACTS" | "MAP";
}

/** Re-anchor actions use the visible cursor that opened the editor. NAV and
 * Facts keep that story-row focus while their overlay is open; the Map lens
 * owns its own selected tree node. Pending and summary rows are not valid
 * Fact anchors, so they fail closed instead of leaking a non-persisted id. */
function factEditorCursorAnchorId(
  state: RuntimeState,
  returnMode: FactEditorOpenOptions["returnMode"]
): string | null {
  const persistedPartId = (candidateId: string | null | undefined): string | null => {
    if (candidateId === null || candidateId === undefined) return null;
    const node = state.payload.nodes.find(({ id }) => id === candidateId);
    return node === undefined || node.role === "summary" ? null : node.id;
  };
  if (returnMode === "MAP") {
    return persistedPartId(state.map?.treeCursorId);
  }
  const view = createStoryViewModel(state.payload, state.stream);
  const focusedRow = view.rows[state.focusIndex];
  if (focusedRow !== undefined) {
    const part = rowPart(view, state.focusIndex);
    return persistedPartId(part?.node.id);
  }
  return persistedPartId(state.payload.path.at(-1)?.id);
}

export function openFactEditor(
  state: RuntimeState,
  fact: StoryFact | null,
  options: FactEditorOpenOptions = {}
): void {
  const states = fact === null ? [] : [...canonicalFactStates(fact)];
  const resolved = fact === null ? null : resolveFactState(fact, state.payload.path);
  const resolvedState = resolved?.kind === "active" || resolved?.kind === "ended"
    ? resolved.state
    : states[0];
  const selectedState = options.stateId === undefined
    ? resolvedState
    : states.find(({ id }) => id === options.stateId);
  const stateCreating = options.stateCreating === true;
  const returnMode = options.returnMode ?? "FACTS";
  // Every saved Fact can now add a state from this editor. Keep the canonical
  // legacy state shape until a state action or other state feature needs more
  // history; opening the editor alone does not rewrite storage.
  const stateful = fact !== null;
  const text = stateCreating
    ? ""
    : selectedState === undefined || isFactEndState(selectedState)
      ? fact === null ? "" : firstFactText(fact)
      : selectedState.text;
  const composer = createComposer(text);
  const name = fact?.name ?? "";
  const editor: Omit<FactEditorSession, "kind"> = {
    target: { kind: "fact", factId: fact?.id ?? null, base: fact },
    factAnchorPartId: options.anchorPartId ?? null,
    ...(fact === null && !stateCreating
      ? { factScopeAnchorPartId: options.anchorPartId ?? state.payload.path.at(-1)?.id ?? null }
      : {}),
    composer,
    name: createComposer(name),
    initialName: fact?.name ?? null,
    ...(stateful || stateCreating ? {
      stateId: stateCreating ? null : selectedState?.id ?? null,
      stateIndex: selectedState === undefined ? 0 : Math.max(0, states.indexOf(selectedState)),
      stateCreating,
      stateAnchorPartId: stateCreating
        ? options.anchorPartId ?? null
        : selectedState?.anchorPartId ?? null,
      stateCursorAnchorId: factEditorCursorAnchorId(state, returnMode),
      stateInitialId: stateCreating ? null : selectedState?.id ?? null,
      stateInitialAnchorPartId: stateCreating
        ? options.anchorPartId ?? null
        : selectedState?.anchorPartId ?? null,
      stateInitialText: stateCreating || selectedState === undefined || isFactEndState(selectedState)
        ? ""
        : selectedState.text,
      stateInitialEnds: !stateCreating && selectedState !== undefined && isFactEndState(selectedState),
      stateIsEnd: !stateCreating && selectedState !== undefined && isFactEndState(selectedState)
    } : {}),
    tag: createComposer(fact?.tag ?? ""),
    activation: fact?.activation ?? "always",
    keys: createComposer(formatFactKeys(fact?.keys ?? [])),
    secondary: createComposer(formatFactKeys(fact?.secondaryKeys ?? [])),
    secondaryMode: fact?.secondaryMode ?? "and",
    scan: createComposer(formatFactScanDepth(fact?.scanDepth)),
    recursion: fact?.recursion ?? "on",
    priority: fact?.priority ?? "normal",
    budget: createComposer(formatFactBudget(fact?.budgetTokens)),
    focus: "body",
    initialFact: fact === null
      ? EMPTY_FACT_DRAFT
      : {
          ...factDraftOf(fact),
          ...(stateful && selectedState !== undefined && !isFactEndState(selectedState)
            ? { text: selectedState.text }
            : {})
        },
    title: `${fact === null ? "new" : "edit"} fact`,
    placeholder: "fact text…",
    returnMode,
    conflict: null
  };
  initializeFactEditorHistory(editor);
  openFactSession(state, editor);
}

/** Open the existing Fact on a fresh state draft. The caller supplies the
 * current story cursor as the default anchor; the editor can re-anchor before
 * save. */
export function openFactStateEditor(
  state: RuntimeState,
  fact: StoryFact,
  anchorPartId: string | null = null
): void {
  openFactEditor(state, fact, {
    stateCreating: true,
    anchorPartId
  });
}

export function openFactFromSelection(state: RuntimeState, text: string): void {
  const composer = createComposer(text);
  if (text.length > 0) composer.anchor = 0;
  const editor: Omit<FactEditorSession, "kind"> = {
    target: { kind: "fact", factId: null, base: null },
    factAnchorPartId: null,
    factScopeAnchorPartId: state.payload.path.at(-1)?.id ?? null,
    composer,
    name: createComposer(""),
    initialName: null,
    tag: createComposer(""),
    activation: "always",
    keys: createComposer(""),
    secondary: createComposer(""),
    secondaryMode: "and",
    scan: createComposer(""),
    recursion: "on",
    priority: "normal",
    budget: createComposer(""),
    focus: "body",
    // This prefill is an unsaved draft, so Ctrl+S must create it unchanged.
    initialFact: EMPTY_FACT_DRAFT,
    title: "new fact from selection",
    placeholder: "fact text…",
    returnMode: "NAV",
    conflict: null
  };
  initializeFactEditorHistory(editor);
  openFactSession(state, editor);
}

export function openChapterSummaryEditor(
  state: RuntimeState,
  summaryId: string,
  text: string,
  chapterNumber: number
): void {
  openInlineEditor(state, {
    target: { kind: "chapter-summary", summaryId, expected: text },
    composer: createComposer(text),
    initial: text,
    title: `edit chapter ${chapterNumber} summary`,
    placeholder: "chapter summary…",
    returnMode: "NAV",
    conflict: null
  });
}

export function openAuthorsNoteEditor(state: RuntimeState): void {
  const initial = state.payload.authorsNote ?? "";
  const depth = resolveAuthorsNoteDepth(state.payload.authorsNoteDepth);
  openInlineEditor(state, {
    target: { kind: "authors-note", expected: initial, expectedDepth: depth, depth },
    composer: createComposer(initial),
    initial,
    title: "author's note",
    placeholder: "Steer the next passage. Style, tone, what is true right now. ⌃s keeps it.",
    returnMode: "NAV",
    conflict: null
  });
}

export function openAuthorBriefEditor(state: RuntimeState): void {
  openStoryScalarEditor(state, "author-brief");
}

/** The story's total Facts budget. Its text field follows the same "empty
 *  means unset" convention as the per-Fact budget field. */
export function openFactsBudgetEditor(state: RuntimeState): void {
  openStoryScalarEditor(state, "facts-budget");
}

/** This story's own phrase bias, added to the routed profile's own (issue
 *  #341) — see the field comment on `Story.phraseBias` (shared/types.ts). */
export function openPhraseBiasEditor(state: RuntimeState): void {
  openStoryScalarEditor(state, "phrase-bias");
}

/** This story's own banned strings, added to the routed profile's own. */
export function openBannedStringsEditor(state: RuntimeState): void {
  openStoryScalarEditor(state, "banned-strings");
}

/** Author Brief and the Facts budget both open through this one path,
 *  table-driven by STORY_SCALAR_FIELDS (see story-scalar-fields.ts) — the
 *  next story-level scalar is a table row, not a new open function. */
function openStoryScalarEditor(state: RuntimeState, field: StoryScalarField): void {
  const spec = storyScalarFieldSpec(field);
  const expected = spec.read(state.payload);
  openInlineEditor(state, {
    target: { kind: "story-scalar", field, expected },
    composer: createComposer(expected),
    initial: expected,
    title: spec.title,
    placeholder: spec.placeholder,
    returnMode: "NAV",
    conflict: null
  });
}

function openInlineEditor(
  state: RuntimeState,
  editor: Omit<InlineEditorSession, "kind">
): void {
  state.textActions = null;
  state.editor = { kind: "document", ...editor };
  state.editorScrollTop = 0;
  state.editorScrollDetached = false;
  state.mode = "EDITOR";
}

function openFactSession(
  state: RuntimeState,
  editor: Omit<FactEditorSession, "kind">
): void {
  state.textActions = null;
  state.editor = { kind: "fact", ...editor };
  state.editorScrollTop = 0;
  state.editorScrollDetached = false;
  state.mode = "EDITOR";
}
