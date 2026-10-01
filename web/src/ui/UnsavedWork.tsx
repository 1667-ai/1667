import { useMemo } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { unsavedWork } from "../app/unsaved-work.js";

/**
 * Lists the writing that lives only in this page — a changed editor, unsent
 * composer text — on the screens that replace or cover the story, each with a
 * Copy button. Renders nothing when there is none.
 */
export function UnsavedWork() {
  const { store } = useAppContext();
  const editor = useStore(store, (state) => state.editor);
  const compose = useStore(store, (state) => state.compose);
  const items = useMemo(() => unsavedWork(editor, compose), [editor, compose]);
  if (items.length === 0) return null;
  return (
    <section className="unsaved-work" aria-label="Unsaved work">
      {items.map((item) => (
        <div key={item.id} className="unsaved-work-item">
          <span className="unsaved-work-label">{item.label}</span>
          <textarea className="unsaved-work-text" readOnly rows={2} aria-label={item.label} value={item.text} />
          <button
            type="button"
            className="btn"
            title={`Copy: ${item.label.toLowerCase()}`}
            onClick={() => {
              navigator.clipboard.writeText(item.text).catch(() => {
                pushToast(store, "Could not copy the text. Select it and copy it by hand.");
              });
            }}
          >
            Copy
          </button>
        </div>
      ))}
    </section>
  );
}

/** True when `UnsavedWork` has something to show. */
export function useHasUnsavedWork(): boolean {
  const { store } = useAppContext();
  const editor = useStore(store, (state) => state.editor);
  const compose = useStore(store, (state) => state.compose);
  return useMemo(() => unsavedWork(editor, compose).length > 0, [editor, compose]);
}
