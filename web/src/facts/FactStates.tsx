import { useState } from "react";
import { factStateText, isFactEndState, isFactStateful } from "../../../shared/fact-state.js";
import { factDossierEntries } from "../../../shared/fact-view.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { Icon, ICONS } from "../ui/icons.js";
import { factEditorDirty, type FactEditor } from "./state.js";

/** The states of the fact being edited (#409 step 7c): where each one starts,
 * what it says, which one is in effect on this line, and the buttons that add
 * one at the part being read. Hidden when the backend has no state calls. */
export function FactStates({ payload, editor }: { readonly payload: StoryPayload; readonly editor: FactEditor }) {
  const { store, actions } = useAppContext();
  const focusedId = useStore(store, (state) => (state.story.kind === "loaded" ? effectiveFocusedPartId(state.story) : null));
  const available = useStore(store, (state) => (
    state.connection.kind === "connected" && state.connection.api.createFactState !== undefined
  ));
  const factsBusy = useStore(store, (state) => state.facts.busy);
  const [confirming, setConfirming] = useState<string | null>(null);
  const fact = editor.factId === null ? undefined : payload.facts.find((candidate) => candidate.id === editor.factId);
  if (fact === undefined || !available) return null;

  const entries = factDossierEntries(fact, payload);
  const stateful = isFactStateful(fact);
  const partNumber = focusedId === null ? 0 : payload.path.findIndex((node) => node.id === focusedId) + 1;
  const editingId = editor.body.kind === "state" ? editor.body.stateId : null;
  const busy = editor.saving || factsBusy;
  const hasStoryWide = entries.some((entry) => entry.state.anchorPartId === undefined);
  const adding = editor.body.kind === "new-state";

  return (
    <section className="fact-states" aria-label="States">
      <span className="facts-label">States</span>
      {stateful && (
        <ul className="fact-state-list">
          {entries.map((entry) => (
            <li key={entry.state.id} className={`fact-state-row${entry.state.id === editingId ? " editing" : ""}`}>
              <span className="fact-state-anchor">{entry.anchorLabel}</span>
              <span className="fact-state-text">
                {isFactEndState(entry.state) ? "ends here" : factStateText(entry.state)}
              </span>
              {entry.effective && <span className="fact-state-flag">in effect</span>}
              <button
                type="button"
                className="icon-btn"
                title={`Edit state ${entry.index + 1}`}
                aria-label={`Edit state ${entry.index + 1}`}
                disabled={busy || entry.state.id === editingId || isFactEndState(entry.state)}
                onClick={() => actions.facts.openState(entry.state.id)}
              >
                <Icon path={ICONS.penLine} />
              </button>
              {entries.length > 1 && (confirming === entry.state.id
                ? (
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    autoFocus
                    title="Confirm delete"
                    onBlur={() => setConfirming(null)}
                    onClick={() => { setConfirming(null); void actions.facts.deleteState(fact.id, entry.state.id); }}
                  >
                    Confirm
                  </button>
                )
                : (
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Delete state ${entry.index + 1}`}
                    aria-label={`Delete state ${entry.index + 1}`}
                    disabled={busy}
                    onClick={() => setConfirming(entry.state.id)}
                  >
                    <Icon path={ICONS.trash} />
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {!adding && (
        <div className="fact-state-adders">
          {focusedId !== null && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              title={`New state from part ${partNumber}`}
              onClick={() => actions.facts.openNewState(fact.id, focusedId, false)}
            >
              New state at part {partNumber}
            </button>
          )}
          {!hasStoryWide && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              title="A state for the whole story"
              onClick={() => actions.facts.openNewState(fact.id, null, false)}
            >
              Story-wide state
            </button>
          )}
          {focusedId !== null && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              title={`End this fact at part ${partNumber}`}
              onClick={() => actions.facts.openNewState(fact.id, focusedId, true)}
            >
              End at part {partNumber}
            </button>
          )}
        </div>
      )}
      {!adding && factEditorDirty(editor) && (
        <p className="facts-note">Save or cancel the changes first to add or open a state.</p>
      )}
    </section>
  );
}
