import type { StoryFact } from "../../shared/types.js";
import { createComposer } from "./composer-model.js";
import { serializePart, stripGuidance } from "./editor.js";
import { serializeFactEditor } from "./facts-model.js";
import { createStoryViewModel, rowPart } from "./model.js";
import type { InlineEditorSession, RuntimeState } from "./state.js";

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
  const initial = serializeFactEditor(fact);
  openInlineEditor(state, {
    target: { kind: "fact", factId: fact?.id ?? null, base: fact },
    composer: createComposer(initial),
    initial,
    title: `${fact === null ? "new" : "edit"} fact · optional tag: first line`,
    placeholder: "tag: optional\n\nfact text…",
    returnMode: "FACTS",
    conflict: null,
    cutConfirmation: null
  });
}

export function openFactFromSelection(state: RuntimeState, text: string): void {
  const initial = `tag: \n\n${text}`;
  openInlineEditor(state, {
    target: { kind: "fact", factId: null, base: null },
    composer: createComposer(initial),
    // This prefill is an unsaved draft, so Ctrl+S must create it unchanged.
    initial: serializeFactEditor(null),
    title: "new fact from selection · optional tag: first line",
    placeholder: "tag: optional\n\nfact text…",
    returnMode: "NAV",
    conflict: null,
    cutConfirmation: null
  });
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

function openInlineEditor(state: RuntimeState, editor: InlineEditorSession): void {
  editor.composer.fullscreen = true;
  state.editor = editor;
  state.editorScrollTop = 0;
  state.mode = "EDITOR";
}
