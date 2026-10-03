import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { FACT_ACTIVATIONS, FACT_PRIORITIES, FACT_RECURSIONS, FACT_SECONDARY_MODES } from "../../../shared/fact-metadata.js";
import { factTagPresets } from "../../../shared/fact-view.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { IS_MAC } from "../app/platform.js";
import { Modal } from "../ui/Modal.js";
import { FactStates } from "./FactStates.js";
import { factEditorDirty, type FactEditor as FactEditorState } from "./state.js";
import type { FactFormField } from "./form.js";

const MOD = IS_MAC ? "⌘" : "Ctrl+";

const LABELS: Readonly<Record<string, string>> = {
  always: "Always", keyed: "Keyed", low: "Low", normal: "Normal", high: "High", and: "And", not: "Not", on: "On", off: "Off"
};

/** A row of choices that behaves as one radio group. */
function Choice<T extends string>(
  { label, field, options, value, disabled, hint }: {
    readonly label: string;
    readonly field: FactFormField;
    readonly options: readonly T[];
    readonly value: T;
    readonly disabled: boolean;
    readonly hint?: string;
  }
) {
  const { actions } = useAppContext();
  return (
    <div className="facts-field">
      <span className="facts-label" title={hint}>{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className="seg-btn"
            disabled={disabled}
            onClick={() => actions.facts.setField(field, option)}
          >
            {LABELS[option] ?? option}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The fact editor: Name, Tag and Text up front, the activation and budget
 * fields under "More". The draft lives in the store (`facts/state.ts`). */
export function FactEditor({ payload, editor }: { readonly payload: StoryPayload; readonly editor: FactEditorState }) {
  const { store, actions } = useAppContext();
  const nameRef = useRef<HTMLInputElement>(null);
  const [more, setMore] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { form, body } = editor;
  const dirty = factEditorDirty(editor);
  const ends = body.kind !== "fact" && body.ends;
  const isNew = editor.factId === null;
  const factsBusy = useStore(store, (state) => state.facts.busy);
  const busy = editor.saving || factsBusy;

  useEffect(() => {
    nameRef.current?.focus();
    // The editor's controls leave the page when it closes; the panel takes
    // the keyboard back so its list keys work.
    return () => {
      setTimeout(() => {
        if (document.activeElement === null || document.activeElement === document.body) {
          document.querySelector<HTMLElement>(".story-panel")?.focus();
        }
      }, 0);
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // The delete confirm is a dialog with its own Esc.
    if (event.nativeEvent.isComposing || (event.target as HTMLElement).closest("dialog") !== null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      actions.facts.requestClose();
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void actions.facts.save();
    }
  };

  const text = (field: FactFormField, label: string, options: { readonly placeholder?: string; readonly list?: string } = {}) => (
    <div className="facts-field">
      <label className="facts-label" htmlFor={`fact-${field}`}>{label}</label>
      <input
        id={`fact-${field}`}
        ref={field === "name" ? nameRef : undefined}
        className="facts-input"
        value={form[field]}
        disabled={busy}
        placeholder={options.placeholder}
        list={options.list}
        onChange={(event) => actions.facts.setField(field, event.target.value)}
      />
    </div>
  );

  return (
    <div className="facts-editor" role="form" aria-label={isNew ? "New fact" : "Edit fact"} onKeyDown={onKeyDown}>
      <div className="facts-editor-title">
        {body.kind === "new-state" ? (ends ? "New end of fact" : "New fact state") : isNew ? "New fact" : "Edit fact"}
      </div>
      {text("name", "Name", { placeholder: "Optional" })}
      {text("tag", "Tag", { placeholder: "people, places, rules…", list: "fact-tags" })}
      <datalist id="fact-tags">
        {factTagPresets(payload.facts, form.tag.trim().length > 0 ? form.tag.trim() : null)
          .filter((tag): tag is string => tag !== null)
          .map((tag) => <option key={tag} value={tag} />)}
      </datalist>
      {ends
        ? <p className="facts-note">This state ends the fact here. It has no text.</p>
        : (
          <div className="facts-field">
            <label className="facts-label" htmlFor="fact-text">Text</label>
            <textarea
              id="fact-text"
              className="facts-input facts-textarea"
              value={form.text}
              disabled={busy}
              onChange={(event) => actions.facts.setField("text", event.target.value)}
            />
          </div>
        )}
      <button
        type="button"
        className="btn btn-ghost btn-small facts-more"
        aria-expanded={more}
        title={more ? "Hide the extra fields" : "Show the extra fields"}
        onClick={() => setMore(!more)}
      >
        More
      </button>
      {more && (
        <div className="facts-more-fields">
          <Choice label="Activation" field="activation" options={FACT_ACTIVATIONS} value={form.activation} disabled={busy} hint="Always sends the fact. Keyed sends it when a key matches." />
          {text("keys", "Keys", { placeholder: "Comma separated" })}
          {text("secondaryKeys", "Secondary keys", { placeholder: "Comma separated" })}
          <Choice label="Secondary mode" field="secondaryMode" options={FACT_SECONDARY_MODES} value={form.secondaryMode} disabled={busy} hint="And needs a secondary key. Not blocks on one." />
          {text("scanDepth", "Scan depth", { placeholder: "Parts to scan" })}
          <Choice label="Chain" field="recursion" options={FACT_RECURSIONS} value={form.recursion} disabled={busy} hint="On lets this fact's text trigger other facts." />
          <Choice label="Priority" field="priority" options={FACT_PRIORITIES} value={form.priority} disabled={busy} hint="Low facts drop first when space runs out." />
          {text("budget", "Fact cap", { placeholder: "Tokens, empty for none" })}
        </div>
      )}
      <FactStates payload={payload} editor={editor} />
      {editor.overwriteArmed && (
        <p className="facts-note" role="status">This fact changed in another window. Save again to overwrite.</p>
      )}
      {editor.discardArmed && <p className="facts-note" role="status">Esc again discards your changes.</p>}
      <div className="facts-editor-actions">
        <button type="button" className="btn btn-primary" disabled={busy} title={`Save (${MOD}S)`} onClick={() => { void actions.facts.save(); }}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy || !dirty} title="Revert changes" onClick={actions.facts.revert}>
          Revert
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} title="Cancel (Esc)" onClick={actions.facts.requestClose}>
          {dirty && editor.discardArmed ? "Discard changes" : "Cancel"}
        </button>
        {!isNew && body.kind !== "new-state" && (
          <button type="button" className="btn btn-danger facts-delete" disabled={busy} title="Delete fact" onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
        )}
      </div>
      {confirmingDelete && editor.factId !== null && (
        <Modal onCancel={() => setConfirmingDelete(false)} ariaLabel="Delete fact">
          <h2>Delete fact</h2>
          <p className="modal-status">Delete this fact and all of its states? This cannot be undone.</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" title="Cancel (Esc)" autoFocus onClick={() => setConfirmingDelete(false)}>Cancel</button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirmingDelete(false);
                void actions.facts.deleteFact(editor.factId!);
              }}
            >
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
