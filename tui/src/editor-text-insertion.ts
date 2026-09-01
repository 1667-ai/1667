import { insertComposerText, type ComposerState } from "./composer-model.js";
import { factEditorInsert } from "./fact-editor-policy.js";
import { factsBudgetInsert, isFactsBudgetEditor } from "./facts-budget-editor.js";
import type { DocumentEditorSession } from "./state.js";

export interface EditorTextBuffer {
  composer: ComposerState;
}

export interface EditorTextHost {
  toast?: string | null;
}

export type EditorTextSource = "paste" | "input" | "newline";

export interface EditorTextInsertionPolicy {
  readonly disarmConflict: () => void;
  readonly insert: (
    raw: string,
    source: EditorTextSource
  ) => { text: string } | { blocked: string };
}

/** Resolve target-specific admission and conflict policy once for every paste
 * and keyboard insertion path. */
export function editorInsertionPolicy(
  editor: DocumentEditorSession
): EditorTextInsertionPolicy {
  return {
    disarmConflict: () => {
      if (editor.kind === "document"
        && editor.target.kind === "settings-prompt"
        && editor.target.owner.conflict !== null) {
        editor.target.owner.conflict.armed = false;
      } else if (editor.conflict !== null) {
        editor.conflict.armed = false;
      }
    },
    insert: (raw, source) =>
      editor.kind === "fact"
        ? factEditorInsert(editor, raw, source)
        : isFactsBudgetEditor(editor)
          ? factsBudgetInsert(raw)
        : { text: raw }
  };
}

/** Apply one admitted editor insertion. All editor input paths use this policy. */
export function insertEditorText(
  host: EditorTextHost,
  buffer: EditorTextBuffer,
  policy: EditorTextInsertionPolicy,
  raw: string,
  source: EditorTextSource
): void {
  policy.disarmConflict();
  buffer.composer.cutConfirmation = null;
  const admitted = policy.insert(raw, source);
  if ("blocked" in admitted) {
    host.toast = admitted.blocked;
  } else {
    insertComposerText(buffer.composer, admitted.text);
  }
}
