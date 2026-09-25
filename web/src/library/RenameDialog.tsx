import { useState } from "react";
import { Modal } from "../ui/Modal.js";

/**
 * A native `<dialog>`, via the shared lifecycle in `ui/Modal.tsx`:
 * `showModal()` gives it the browser's own focus trap and `::backdrop`, and
 * its `cancel` event already fires on Escape. Enter submits because the
 * title field sits in a `<form>` the Save button belongs to — no keybinding
 * code needed for either.
 */
export function RenameDialog(
  { title, onCancel, onSave }: {
    readonly title: string;
    readonly onCancel: () => void;
    readonly onSave: (title: string) => void;
  }
) {
  const [value, setValue] = useState(title);
  const trimmed = value.trim();

  return (
    <Modal onCancel={onCancel} ariaLabel="Rename story">
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length > 0) onSave(trimmed);
        }}
      >
        <h2>Rename story</h2>
        <div className="field">
          <label htmlFor="rename-title">Title</label>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            id="rename-title"
            type="text"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={trimmed.length === 0}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
