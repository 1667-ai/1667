import type { StoryFact } from "../../shared/types.js";
import { EMPTY_FACT_DRAFT, factDraftOf } from "../../shared/fact-draft.js";
import { resolveAuthorsNoteDepth } from "../../shared/authors-note.js";
import { createComposer } from "./composer-model.js";
import { formatFactBudget, formatFactKeys } from "./fact-editor-draft.js";
import { initializeFactEditorHistory } from "./fact-editor-policy.js";
import { serializePart, stripGuidance } from "./editor.js";
import { createStoryViewModel, rowPart } from "./model.js";
import { storyScalarFieldSpec, type StoryScalarField } from "./story-scalar-fields.js";
import type {
  FactEditorSession,
  InlineEditorSession,
  RuntimeState
} from "./state.js";

export {
  openSettingsPasteTarget,
  openSystemPromptEditor
} from "./settings-prompt-editor.js";

export function openPartEditor(state: RuntimeState, humanSibling: boolean): void {
  const part = rowPart(createStoryViewModel(state.payload), state.focusIndex);
  if (part === null) return;
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
      : `edit ¶ ${part.number} · direction above --- · prose below`,
    placeholder: humanSibling ? "write the sibling take…" : "direction\n---\nprose",
    returnMode: "NAV",
    conflict: null
  });
}

export function openFactEditor(state: RuntimeState, fact: StoryFact | null): void {
  const text = fact?.text ?? "";
  const composer = createComposer(text);
  const editor: Omit<FactEditorSession, "kind"> = {
    target: { kind: "fact", factId: fact?.id ?? null, base: fact },
    composer,
    tag: createComposer(fact?.tag ?? ""),
    activation: fact?.activation ?? "always",
    keys: createComposer(formatFactKeys(fact?.keys ?? [])),
    priority: fact?.priority ?? "normal",
    budget: createComposer(formatFactBudget(fact?.budgetTokens)),
    focus: "body",
    initialFact: fact === null ? EMPTY_FACT_DRAFT : factDraftOf(fact),
    title: `${fact === null ? "new" : "edit"} fact`,
    placeholder: "fact text…",
    returnMode: "FACTS",
    conflict: null
  };
  initializeFactEditorHistory(editor);
  openFactSession(state, editor);
}

export function openFactFromSelection(state: RuntimeState, text: string): void {
  const composer = createComposer(text);
  if (text.length > 0) composer.anchor = 0;
  const editor: Omit<FactEditorSession, "kind"> = {
    target: { kind: "fact", factId: null, base: null },
    composer,
    tag: createComposer(""),
    activation: "always",
    keys: createComposer(""),
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
  state.mode = "EDITOR";
}

function openFactSession(
  state: RuntimeState,
  editor: Omit<FactEditorSession, "kind">
): void {
  state.textActions = null;
  state.editor = { kind: "fact", ...editor };
  state.editorScrollTop = 0;
  state.mode = "EDITOR";
}
