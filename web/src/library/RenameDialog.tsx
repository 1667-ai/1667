import { useEffect, useRef, useState } from "react";

/**
 * A native `<dialog>` (never `window.confirm`): `showModal()` gives it the
 * browser's own focus trap and `::backdrop`, and its `cancel` event already
 * fires on Escape, so this only has to wire that event to `onCancel`. Enter
 * submits because the title field sits in a `<form>` the Save button
 * belongs to — no keybinding code needed for either.
 */
export function RenameDialog(
  { title, onCancel, onSave }: {
    readonly title: string;
    readonly onCancel: () => void;
    readonly onSave: (title: string) => void;
  }
) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(title);
  const trimmed = value.trim();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    dialog.showModal();
    const onCancelEvent = (event: Event): void => {
      event.preventDefault();
      onCancel();
    };
    dialog.addEventListener("cancel", onCancelEvent);
    return () => {
      dialog.removeEventListener("cancel", onCancelEvent);
      if (dialog.open) dialog.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <dialog ref={dialogRef} className="modal" aria-label="Rename story">
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
    </dialog>
  );
}
