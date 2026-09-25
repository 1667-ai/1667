import { useEffect, useRef } from "react";

/** A native `<dialog>` confirm (never `window.confirm`) — see `RenameDialog.tsx`
 * for why `showModal()` alone covers the backdrop, focus trap, and Escape. */
export function DeleteDialog(
  { title, onCancel, onDelete }: {
    readonly title: string;
    readonly onCancel: () => void;
    readonly onDelete: () => void;
  }
) {
  const dialogRef = useRef<HTMLDialogElement>(null);

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
    <dialog ref={dialogRef} className="modal" aria-label="Delete story">
      <h2>Delete story</h2>
      <p className="modal-status">Delete {title}? This cannot be undone.</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={onDelete}>Delete</button>
      </div>
    </dialog>
  );
}
