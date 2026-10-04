import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Modal } from "../ui/Modal.js";

/**
 * The result of an import: the Facts it added and what it left out. The
 * "left out" list is the Fidelity Report, the same lines the TUI writes to its
 * log. Esc or Close dismisses it.
 */
export function ImportReportDialog() {
  const { store, actions } = useAppContext();
  const report = useStore(store, (state) => state.imports.report);
  if (report === null) return null;
  return (
    <Modal onCancel={actions.imports.closeReport} ariaLabel="Import result" className="import-modal">
      <h2>{report.heading}</h2>
      <p className="modal-status">{report.summary}</p>
      {report.facts.length > 0 && (
        <section className="import-section" aria-label="Facts added">
          <h3>Facts added</h3>
          <ul className="import-list">
            {report.facts.map((name, index) => <li key={index}>{name}</li>)}
          </ul>
        </section>
      )}
      <section className="import-section" aria-label="Left out">
        <h3>Left out</h3>
        {report.leftOut.length === 0
          ? <p className="modal-status">Nothing was left out.</p>
          : (
            <ul className="import-list">
              {report.leftOut.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          )}
      </section>
      <div className="modal-actions">
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <button type="button" className="btn btn-primary" autoFocus title="Close (Esc)" onClick={actions.imports.closeReport}>Close</button>
      </div>
    </Modal>
  );
}
