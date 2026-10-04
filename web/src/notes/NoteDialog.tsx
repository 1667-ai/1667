import type { KeyboardEvent } from "react";
import {
  AUTHORS_NOTE_WARN_TOKENS,
  MAX_AUTHORS_NOTE_DEPTH,
  MIN_AUTHORS_NOTE_DEPTH
} from "../../../shared/authors-note.js";
import { estimateTokens } from "../../../shared/tokens.js";
import { unicodeScalarLength } from "../../../shared/unicode.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { Modal } from "../ui/Modal.js";
import { noteLimit } from "./actions.js";
import { noteDraftDirty, noteDraftOf, noteFieldLabel } from "./state.js";

const PLACEHOLDER = {
  note: "Steer the next passage. Style, tone, what is true right now.",
  brief: "Override the machine-wide author brief for this story."
} as const;

/**
 * The Author's Note (`n`) and author brief editor: a dialog with a text area,
 * and for the note a depth stepper (how many parts from the end the note
 * lands before). It shows the draft the store holds, so closing it and
 * opening it again brings the text back. Esc closes; Discard drops the draft.
 */
export function NoteDialog() {
  const { store, actions } = useAppContext();
  const open = useStore(store, (state) => state.notes.open);
  const draftState = useStore(store, (state) => state.notes);
  const story = useStore(store, (state) => state.story);
  const busy = draftState.busy;
  if (open === null || story.kind !== "loaded" || story.payload.id !== open.storyId) return null;

  const draft = noteDraftOf(draftState, story.payload, open);
  const dirty = noteDraftDirty(draft);
  const label = noteFieldLabel(open.field);
  const limit = noteLimit(open.field);
  const length = unicodeScalarLength(draft.text, limit.max + 1);
  const tooLong = length > limit.max;
  const tokens = open.field === "note" ? estimateTokens(draft.text) : 0;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void actions.notes.save();
    }
  };

  return (
    <Modal onCancel={actions.notes.close} ariaLabel={label} className="note-modal">
      <form
        className="modal-form"
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.notes.save();
        }}
      >
        <h2>{label}</h2>
        <div className="field">
          <label htmlFor="note-text">{open.field === "note" ? "Note" : "Brief"}</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <textarea
            id="note-text"
            className="note-text"
            autoFocus
            rows={8}
            placeholder={PLACEHOLDER[open.field]}
            readOnly={busy}
            value={draft.text}
            onChange={(event) => actions.notes.setText(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <span className={`note-meta${tooLong ? " note-meta-error" : ""}`}>
            {draft.overwriteArmed === true
              ? "Changed in another window. Save again to overwrite."
              : tooLong
              ? `Too long: at most ${limit.max.toLocaleString("en-US")} characters.`
              : tokens > AUTHORS_NOTE_WARN_TOKENS
                ? `About ${tokens.toLocaleString("en-US")} tokens. A long note crowds the prose it steers.`
                : `${length.toLocaleString("en-US")} / ${limit.max.toLocaleString("en-US")}`}
          </span>
        </div>
        {open.field === "note" && (
          <div className="note-depth">
            <span className="note-depth-label" id="note-depth-label">Depth</span>
            <div className="note-stepper" role="group" aria-labelledby="note-depth-label">
              <button
                type="button"
                className="icon-btn"
                aria-label="Shallower"
                title="Closer to the end"
                disabled={busy || draft.depth <= MIN_AUTHORS_NOTE_DEPTH}
                onClick={() => actions.notes.setDepth(draft.depth - 1)}
              >
                <Icon path={ICONS.minus} />
              </button>
              <output className="note-depth-value" aria-label="Depth value">{draft.depth}</output>
              <button
                type="button"
                className="icon-btn"
                aria-label="Deeper"
                title="Further from the end"
                disabled={busy || draft.depth >= MAX_AUTHORS_NOTE_DEPTH}
                onClick={() => actions.notes.setDepth(draft.depth + 1)}
              >
                <Icon path={ICONS.plus} />
              </button>
            </div>
            <span className="note-depth-hint">
              {draft.depth === 1 ? "Before the last part" : `Before the last ${draft.depth} parts`}
            </span>
          </div>
        )}
        <div className="modal-actions">
          {dirty && (
            <button type="button" className="btn btn-ghost note-discard" title="Drop the draft" onClick={actions.notes.discard}>
              Discard
            </button>
          )}
          <button type="button" className="btn btn-ghost" title={dirty ? "Close, keep the draft (Esc)" : "Close (Esc)"} onClick={actions.notes.close}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" title="Save (Ctrl+Enter)" disabled={busy || tooLong || !dirty}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
