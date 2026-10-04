import { useMemo } from "react";
import { Modal } from "../ui/Modal.js";
import { keysHelpSections } from "./keys-help.js";

/** `?`: the TUI's key reference, cut down to the keys the web handles. */
export function KeysDialog({ onClose }: { readonly onClose: () => void }) {
  const sections = useMemo(() => keysHelpSections(), []);
  return (
    <Modal onCancel={onClose} ariaLabel="Keyboard shortcuts" className="info-modal">
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <h2 tabIndex={-1} autoFocus>Keys</h2>
      <div className="keys-grid">
        {sections.map((section) => (
          <section key={section.title} className="keys-section" aria-label={section.title}>
            <h3 className="menu-heading">{section.title} <span className="keys-blurb">{section.blurb}</span></h3>
            <dl>
              {section.rows.map((row) => (
                <div key={row.description} className="keys-row">
                  <dt className="menu-key">{row.keys}</dt>
                  <dd>{row.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" title="Close (Esc)" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
