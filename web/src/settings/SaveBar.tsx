import { useAppContext } from "../app/context.js";
import { IS_MAC } from "../app/platform.js";
import { useStore } from "../app/store.js";
import { useBarClearance } from "../ui/bar-clearance.js";
import { notActiveText } from "./actions.js";
import { changeCount, invalidCount, isDirty } from "./model.js";
import type { LoadedSettings } from "./state.js";

const SAVE_TITLE = IS_MAC ? "Save (⌘S)" : "Save (Ctrl+S)";

/**
 * The one Save bar: it shows only while something is pending ("N changes",
 * or settings saved but not active), fixed at the bottom of the page above the
 * generation bar. It publishes its height for the toasts (`useBarClearance`).
 */
export function SaveBar({ loaded }: { readonly loaded: LoadedSettings }) {
  const { store, actions } = useAppContext();
  const connected = useStore(store, (state) => state.connection.kind === "connected");
  const running = useStore(store, (state) => state.generation.kind !== "idle");
  const barRef = useBarClearance();
  const dirty = isDirty(loaded);
  const changes = changeCount(loaded);
  const invalid = invalidCount(loaded);
  const notActive = notActiveText(loaded.view);
  const saving = loaded.busy === "save";
  const discarding = loaded.busy === "discard";
  const show = dirty || invalid > 0 || notActive !== null || loaded.notice !== null || loaded.busy !== null
    || loaded.saveIntent !== null;
  if (!show || !loaded.view.editable) return null;

  const messages: { readonly key: string; readonly text: string; readonly danger: boolean }[] = [];
  if (loaded.notice !== null) messages.push({ key: "notice", text: loaded.notice.text, danger: loaded.notice.tone === "error" });
  if (notActive !== null) messages.push({ key: "not-active", text: notActive, danger: true });
  if (dirty || invalid > 0) {
    const parts = [
      ...(dirty ? [`${changes} ${changes === 1 ? "change" : "changes"}`] : []),
      ...(invalid > 0 ? [`Fix ${invalid} ${invalid === 1 ? "field" : "fields"}`] : [])
    ];
    messages.push({ key: "changes", text: parts.join(" · "), danger: invalid > 0 });
    if (dirty && running) messages.push({ key: "running", text: "A generation is running. Settings apply from the next request.", danger: false });
  }

  return (
    <div ref={barRef} className="settings-bar" role="region" aria-label="Settings changes">
      <div className="settings-bar-text">
        {messages.map((message) => (
          <span
            key={message.key}
            className={message.danger ? "settings-bar-danger" : undefined}
            role={message.key === "notice" ? "alert" : undefined}
          >
            {message.text}
          </span>
        ))}
      </div>
      <div className="settings-bar-actions">
        {dirty || invalid > 0 || loaded.saveIntent !== null
          ? (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                title="Discard the changes"
                disabled={loaded.busy !== null}
                onClick={actions.settings.discardDraft}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn btn-primary"
                title={SAVE_TITLE}
                aria-keyshortcuts={IS_MAC ? "Meta+S" : "Control+S"}
                disabled={loaded.busy !== null || invalid > 0 || !connected}
                onClick={() => { void actions.settings.save(); }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )
          : notActive !== null && (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                title="Remove the saved settings that did not activate"
                disabled={loaded.busy !== null || !connected}
                onClick={() => { void actions.settings.discardPending(); }}
              >
                {discarding ? "Discarding…" : "Discard pending"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                title="Try to activate the saved settings again"
                disabled={loaded.busy !== null || !connected}
                onClick={() => { void actions.settings.save(); }}
              >
                {saving ? "Activating…" : "Retry activation"}
              </button>
            </>
          )}
      </div>
    </div>
  );
}
