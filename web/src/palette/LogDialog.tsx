import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Modal } from "../ui/Modal.js";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** `!`: everything the app said in this tab, newest first, each with its time. */
export function LogDialog({ onClose }: { readonly onClose: () => void }) {
  const { store } = useAppContext();
  const notices = useStore(store, (state) => state.notices);
  const newestFirst = [...notices].reverse();
  return (
    <Modal onCancel={onClose} ariaLabel="Notice log" className="info-modal">
      <h2>Log</h2>
      {newestFirst.length === 0
        ? <p className="modal-status">Nothing yet.</p>
        : (
          <ol className="log-list" aria-label="Notices">
            {newestFirst.map((notice) => (
              <li key={notice.id} className="log-row">
                <time className="menu-key" dateTime={new Date(notice.at).toISOString()}>{TIME.format(notice.at)}</time>
                <span>{notice.text}</span>
              </li>
            ))}
          </ol>
        )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" title="Close (Esc)" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
