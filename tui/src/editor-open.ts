import type { StoryFact } from "../../shared/types.js";
import { createComposer } from "./composer-model.js";
import { initializeFactEditorHistory } from "./fact-editor-policy.js";
import { serializePart, stripGuidance } from "./editor.js";
import { createStoryViewModel, rowPart } from "./model.js";
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
    conflict: null,
    cutConfirmation: null
  });
}

export function openFactEditor(state: RuntimeState, fact: StoryFact | null): void {
  const text = fact?.text ?? "";
  const composer = createComposer(text);
  const editor: Omit<FactEditorSession, "kind"> = {
    target: { kind: "fact", factId: fact?.id ?? null, base: fact },
    composer,
    tag: createComposer(fact?.tag ?? ""),
    focus: "body",
    initialFact: { tag: fact?.tag ?? null, text },
    title: `${fact === null ? "new" : "edit"} fact`,
    placeholder: "fact text…",
    returnMode: "FACTS",
    conflict: null,
    cutConfirmation: null,
    tagCutConfirmation: null
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
    focus: "body",
    // This prefill is an unsaved draft, so Ctrl+S must create it unchanged.
    initialFact: { tag: null, text: "" },
    title: "new fact from selection",
    placeholder: "fact text…",
    returnMode: "NAV",
    conflict: null,
    cutConfirmation: null,
    tagCutConfirmation: null
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
    conflict: null,
    cutConfirmation: null
  });
}

export function openAuthorsNoteEditor(state: RuntimeState): void {
  const initial = state.payload.authorsNote ?? "";
  openInlineEditor(state, {
    target: { kind: "authors-note", expected: initial },
    composer: createComposer(initial),
    initial,
    title: "author's note",
    placeholder: "Steer the next passage. Style, tone, what is true right now. ⌃s keeps it.",
    returnMode: "NAV",
    conflict: null,
    cutConfirmation: null
  });
}

function openInlineEditor(
  state: RuntimeState,
  editor: Omit<InlineEditorSession, "kind">
): void {
  state.editor = { kind: "document", ...editor };
  state.editorScrollTop = 0;
  state.mode = "EDITOR";
}

function openFactSession(
  state: RuntimeState,
  editor: Omit<FactEditorSession, "kind">
): void {
  state.editor = { kind: "fact", ...editor };
  state.editorScrollTop = 0;
  state.mode = "EDITOR";
}
