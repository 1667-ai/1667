import { useState } from "react";
import { factStateText, isFactEndState, isFactStateful } from "../../../shared/fact-state.js";
import { factDossierEntries, factStateDiff } from "../../../shared/fact-view.js";
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
  const [comparing, setComparing] = useState(false);
  const fact = editor.factId === null ? undefined : payload.facts.find((candidate) => candidate.id === editor.factId);
  if (fact === undefined || !available) return null;

  const entries = factDossierEntries(fact, payload);
  const stateful = isFactStateful(fact);
  const partNumber = focusedId === null ? 0 : payload.path.findIndex((node) => node.id === focusedId) + 1;
  const editingId = editor.body.kind === "state" ? editor.body.stateId : null;
  const busy = editor.saving || factsBusy;
  const hasStoryWide = entries.some((entry) => entry.state.anchorPartId === undefined);
  const adding = editor.body.kind === "new-state";
  const draftBody = editor.body;
  const editingEntry = entries.find((entry) => entry.state.id === editingId);
  const diff = comparing && editingEntry !== undefined ? factStateDiff(fact, editingEntry.index) : null;

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
      {editor.body.kind !== "fact" && (
        <div className="fact-state-tools">
          {focusedId !== null && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              title={`Move this state to part ${partNumber}`}
              onClick={actions.facts.reanchorState}
            >
              Re-anchor here
            </button>
          )}
          {editor.body.kind === "state" && (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              title={editor.body.ends ? "Give this state text again" : "Make this state end the fact"}
              onClick={actions.facts.convertState}
            >
              {editor.body.ends ? "Convert to text" : "Convert to end"}
            </button>
          )}
          {editor.body.kind === "state" && (
            <button
              type="button"
              className="btn btn-small"
              aria-pressed={comparing}
              title="Compare this state with the one before it"
              onClick={() => setComparing(!comparing)}
            >
              Compare
            </button>
          )}
        </div>
      )}
      {draftBody.kind !== "fact" && (draftBody.kind === "new-state" || draftBody.anchorPartId !== draftBody.baseAnchorPartId) && (
        <p className="facts-note" role="status">
          {draftBody.kind === "state" ? "Moves to " : "Starts at "}
          {draftBody.anchorPartId === null
            ? "the whole story"
            : `part ${payload.path.findIndex((node) => node.id === draftBody.anchorPartId) + 1 || "on another line"}`}
          {draftBody.kind === "state" ? ". Save to keep it." : "."}
        </p>
      )}
      {comparing && editor.body.kind === "state" && (
        <div className="fact-diff" role="group" aria-label="Compare states">
          {diff === null
            ? <p className="facts-note">Select a later state to compare it with the one before.</p>
            : (
              <>
                <span className="facts-label">Changes from state {diff.fromIndex + 1} to state {diff.toIndex + 1}</span>
                {diff.omitted.map((line, index) => (
                  <p key={`o${index}`} className="fact-diff-line removed"><span aria-hidden="true">− </span>{line}</p>
                ))}
                {diff.added.map((line, index) => (
                  <p key={`a${index}`} className="fact-diff-line added"><span aria-hidden="true">+ </span>{line}</p>
                ))}
                {diff.omitted.length + diff.added.length === 0 && <p className="facts-note">The two states say the same.</p>}
              </>
            )}
        </div>
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
