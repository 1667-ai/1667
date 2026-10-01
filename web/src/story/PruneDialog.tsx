import { Modal } from "../ui/Modal.js";
import { deleteQuestion, type DeletePlan } from "./part-ui-state.js";

/** The confirm for `D` and the menu's Delete: a native `<dialog>` through
 * `ui/Modal.tsx`, worded like the Library's `DeleteDialog`. Cancel has the
 * first focus, so a stray Enter never deletes. */
export function PruneDialog(
  { plan, deleting, onCancel, onDelete }: {
    readonly plan: DeletePlan;
    readonly deleting: boolean;
    readonly onCancel: () => void;
    readonly onDelete: () => void;
  }
) {
  return (
    <Modal onCancel={onCancel} ariaLabel="Delete part">
      <h2>Delete part {plan.partNumber}</h2>
      <p className="modal-status">{deleteQuestion(plan)}</p>
      <p className="modal-status">
        {plan.lines} {plan.lines === 1 ? "line ends" : "lines end"} there.
        {plan.tags.length > 0 && ` Tags removed: ${plan.tags.join(", ")}.`}
        {plan.factStates > 0 && ` ${plan.factStates} Fact ${plan.factStates === 1 ? "state is" : "states are"} removed.`}
        {" "}This cannot be undone.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" title="Cancel (Esc)" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-danger" disabled={deleting} onClick={onDelete}>
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
