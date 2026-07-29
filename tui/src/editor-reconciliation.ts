import type { StoryFact } from "../../shared/types.js";
import { setComposerText } from "./composer-model.js";
import { serializeFactEditor } from "./facts-model.js";
import type { InlineEditorSession, RuntimeState } from "./state.js";

/** Reconcile an authoritative fact refresh against the active draft. Pristine
 * drafts rebase; dirty drafts stay intact and require an explicit overwrite. */
export function reconcileFactEditor(state: RuntimeState): void {
  const editor = state.editor;
  if (editor?.target.kind !== "fact" || editor.target.factId === null) return;
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
  reconcileEditorDocument(state, editor, serializeFactEditor(current), "fact changed during recovery");
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
