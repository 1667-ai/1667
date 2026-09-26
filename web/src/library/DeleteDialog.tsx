import { Modal } from "../ui/Modal.js";

/** A native `<dialog>` confirm (never `window.confirm`), via the shared
 * lifecycle in `ui/Modal.tsx`. */
export function DeleteDialog(
  { title, onCancel, onDelete }: {
    readonly title: string;
    readonly onCancel: () => void;
    readonly onDelete: () => void;
  }
) {
  return (
    <Modal onCancel={onCancel} ariaLabel="Delete story">
      <h2>Delete story</h2>
      <p className="modal-status">Delete {title}? This cannot be undone.</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={onDelete}>Delete</button>
      </div>
    </Modal>
  );
}
