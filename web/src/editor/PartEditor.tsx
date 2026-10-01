import { useEffect, useRef, type KeyboardEvent } from "react";
import { IS_MAC } from "../app/platform.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import { editorDirty, editorTitle } from "./state.js";

const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

/**
 * The inline editor (#409 step 6) that replaces one part's body at the
 * reading measure: `e` edits the part (Save as new take is primary, Save in
 * place is secondary), `w` writes the writer's own take, empty, with one
 * Save. Enter adds a line. Escape closes a clean editor; a changed one asks
 * for a second Escape first.
 */
export function PartEditor(
  { partNumber, showDirections }: { readonly partNumber: number; readonly showDirections: boolean }
) {
  const { store, actions } = useAppContext();
  const editor = useStore(store, (state) => state.editor);
  const proseRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const field = proseRef.current;
    if (field !== null) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
    // The editor's own controls leave the page when it closes; hand the
    // keyboard back to the part afterwards.
    return () => {
      setTimeout(() => { if (store.get().editor === null) focusCurrentPart(); }, 0);
    };
  }, [store]);

  if (editor === null) return null;
  const summary = editor.mode !== "first" && editor.base.role === "summary";
  const editing = editor.mode === "edit";
  const dirty = editorDirty(editor);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // The window listener in `app/keymap.ts` must not also stop a generation.
      event.preventDefault();
      actions.editor.requestClose();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void actions.editor.save(event.shiftKey ? "in-place" : "new");
    }
  };

  return (
    <div className="part-editor" data-owns-keys onKeyDown={onKeyDown}>
      <div className="part-editor-title">{editorTitle(editor, partNumber)}</div>
      {showDirections && editing && (
        <textarea
          className="part-editor-direction"
          rows={1}
          aria-label="Direction"
          placeholder="Direction"
          value={editor.instruction}
          disabled={editor.saving}
          onChange={(event) => actions.editor.setInstruction(event.target.value)}
        />
      )}
      <textarea
        ref={proseRef}
        className="part-editor-prose"
        aria-label={editing ? `Text of part ${partNumber}` : editorTitle(editor, partNumber)}
        value={editor.text}
        disabled={editor.saving}
        onChange={(event) => actions.editor.setText(event.target.value)}
      />
      {editor.overwriteArmed && (
        <p className="part-editor-note" role="status">The part changed in another window. Save again to overwrite.</p>
      )}
      {editor.discardArmed && (
        <p className="part-editor-note" role="status">Esc again discards your changes.</p>
      )}
      <div className="part-editor-actions">
        {editing && !summary && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={editor.saving}
            title={`Save as new take (${MOD}S)`}
            onClick={() => { void actions.editor.save("new"); }}
          >
            {editor.saving ? "Saving…" : "Save as new take"}
          </button>
        )}
        {editing && (
          <button
            type="button"
            className={summary ? "btn btn-primary" : "btn"}
            disabled={editor.saving}
            title={`Save in place (${MOD}${SHIFT}S)`}
            onClick={() => { void actions.editor.save("in-place"); }}
          >
            Save in place
          </button>
        )}
        {!editing && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={editor.saving}
            title={`Save (${MOD}S)`}
            onClick={() => { void actions.editor.save("new"); }}
          >
            {editor.saving ? "Saving…" : "Save"}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          disabled={editor.saving}
          title="Cancel (Esc)"
          onClick={actions.editor.requestClose}
        >
          {dirty && editor.discardArmed ? "Discard changes" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
