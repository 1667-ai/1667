import { Modal } from "../ui/Modal.js";
import { unusedPruneQuestion, type UnusedPrunePlan } from "./prune-unused.js";

/** The review for "prune drafts & discarded": what goes, what stays, and the
 * counts the server will check. Cancel has the first focus, so a stray Enter
 * never deletes. */
export function PruneUnusedDialog(
  { plan, deleting, onCancel, onDelete }: {
    readonly plan: UnusedPrunePlan;
    readonly deleting: boolean;
    readonly onCancel: () => void;
    readonly onDelete: () => void;
  }
) {
  return (
    <Modal onCancel={onCancel} ariaLabel="Prune unused takes">
      <h2>Prune drafts and discarded takes</h2>
      <p className="modal-status">{unusedPruneQuestion(plan)}</p>
      <p className="modal-status">
        Every take that has a continuation stays. Every tagged line stays. One take stays at each fork.
        This cannot be undone.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" title="Cancel (Esc)" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={deleting} onClick={onDelete}>
          {deleting ? "Deleting…" : `Delete ${plan.takes} ${plan.takes === 1 ? "take" : "takes"}`}
        </button>
      </div>
    </Modal>
  );
}
