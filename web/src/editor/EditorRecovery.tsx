import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { editorCopyText } from "./state.js";
import { pushToast } from "../app/toasts.js";

/**
 * Shown above the manuscript when the part being edited is no longer on the
 * story line — another window deleted it or switched the line away. The
 * editor's own slot is gone, but the writer's text is not: it stays here until
 * the writer copies it and closes it.
 */
export function EditorRecovery() {
  const { store, actions } = useAppContext();
  const text = useStore(store, (state) => (state.editor === null ? "" : state.editor.text));
  const instruction = useStore(store, (state) => (
    state.editor !== null && state.editor.mode === "edit" ? state.editor.instruction : ""
  ));

  const copy = (): void => {
    navigator.clipboard.writeText(store.get().editor === null ? text : editorCopyText(store.get().editor!)).catch(() => {
      pushToast(store, "Could not copy the text. Select it and copy it by hand.");
    });
  };

  return (
    <section className="part-editor part-editor-recovery" aria-label="Editor without a part" data-owns-keys>
      <div className="part-editor-title">The part you were editing is no longer on the story line</div>
      <p className="part-editor-note" role="status">Your text is kept here. Copy it before you close this.</p>
      {instruction.length > 0 && (
        <textarea className="part-editor-direction" rows={1} aria-label="Your unsaved direction" readOnly value={instruction} />
      )}
      <textarea className="part-editor-prose" aria-label="Your unsaved text" readOnly value={text} />
      <div className="part-editor-actions">
        <button type="button" className="btn btn-primary" title="Copy text" onClick={copy}>Copy</button>
        <button type="button" className="btn btn-danger" title="Discard" onClick={actions.editor.discard}>Discard</button>
      </div>
    </section>
  );
}
