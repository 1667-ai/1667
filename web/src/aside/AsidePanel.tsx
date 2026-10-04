import { useEffect, useRef } from "react";
import type { AsideSessionTurnResponse } from "../../../shared/aside-transport.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Modal } from "../ui/Modal.js";
import { Icon, ICONS } from "../ui/icons.js";
import { AsideUseMenu } from "./AsideUseMenu.js";
import { hopEntries, surfaceHeading } from "./model.js";
import { currentSession, retakeTargetIsLast, type AsideConfirm, type AsideRun, type AsideSurface } from "./state.js";

function words(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function confirmText(confirm: AsideConfirm, turns: readonly AsideSessionTurnResponse[]): { title: string; body: string; action: string } {
  if (confirm.kind === "delete") {
    return {
      title: `Delete turn ${confirm.turnIndex + 1}`,
      body: "This question and its answer are removed. This cannot be undone.",
      action: "Delete"
    };
  }
  if (confirm.kind === "reset") {
    const after = turns.slice(confirm.turnIndex + 1);
    const count = after.reduce((sum, turn) => sum + words(`${turn.q} ${turn.a}`), 0);
    return {
      title: `Reset to turn ${confirm.turnIndex + 1}`,
      body: `Everything after this answer is removed: ${after.length} ${after.length === 1 ? "turn" : "turns"}, ${count} words. This cannot be undone.`,
      action: "Reset"
    };
  }
  return {
    title: "Clear this session",
    body: `All ${turns.length} ${turns.length === 1 ? "turn" : "turns"} of this session are removed. This cannot be undone.`,
    action: "Clear"
  };
}

const PHASE_TEXT: Readonly<Record<AsideRun["phase"], string>> = {
  waiting: "Waiting…",
  thinking: "Thinking…",
  writing: "Writing…"
};

function runStatus(run: AsideRun): string {
  return run.stopping ? "Stopping…" : PHASE_TEXT[run.phase];
}

/** The Aside view of the story panel: the heading with its sessions and the
 * other anchors, the turns, and the question box at the bottom. The keys
 * (↑↓, ←→, r, R, D, ⌫, n, [ ], g, i, Esc) are handled by `StoryPanel` through
 * `keys.ts`, which owns the keyboard. */
export function AsidePanel({ payload, onClose }: { readonly payload: StoryPayload; readonly onClose: () => void }) {
  const { store, actions } = useAppContext();
  const surface = useStore(store, (state) => state.aside.surface);
  const run = useStore(store, (state) => state.aside.run);
  const draft = useStore(store, (state) => state.aside.drafts[payload.id] ?? "");
  const retakes = useStore(store, (state) => state.aside.retakes);
  const unsaved = useStore(store, (state) => state.aside.unsaved);
  const confirm = useStore(store, (state) => state.aside.confirm);
  const openSerial = useStore(store, (state) => state.panel.openSerial);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const liveRef = useRef<HTMLLIElement | null>(null);
  const selectedRef = useRef<HTMLLIElement | null>(null);

  const here = surface !== null && surface.storyId === payload.id ? surface : null;
  const session = here === null ? null : currentSession(here);
  const turns = session?.turns ?? [];
  const lastIndex = turns.length - 1;
  const retake = session === null ? undefined : retakes[session.id];
  const retaking = retake !== undefined && session !== null && retakeTargetIsLast(retake, session);
  const active = run !== null && run.storyId === payload.id ? run : null;
  const streaming = active !== null && active.kind !== "change";
  const ready = here !== null && here.load === "ready";
  const turnCursor = here?.turnCursor ?? 0;

  // Opening Aside on a take with no turns goes straight to the question box;
  // with turns, the keyboard stays on the panel for the turn keys.
  const focusedSerial = useRef(-1);
  useEffect(() => {
    if (!ready || focusedSerial.current === openSerial) return;
    focusedSerial.current = openSerial;
    if (turns.length === 0) boxRef.current?.focus();
    // Only when the panel is asked for or the read lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, openSerial]);

  // A retake with an edited question puts the writer in the box.
  useEffect(() => {
    if (retaking) boxRef.current?.focus();
  }, [retaking]);

  useEffect(() => { selectedRef.current?.scrollIntoView({ block: "nearest" }); }, [turnCursor, session?.id]);
  useEffect(() => { liveRef.current?.scrollIntoView({ block: "nearest" }); }, [active?.text, active?.phase]);

  if (here === null) {
    return (
      <>
        <div className="panel-body">
          <p className="panel-empty">Ask a question about a take without changing the story.</p>
          <p className="panel-empty">
            <button type="button" className="btn btn-small" title="Open Aside on this part (a)" onClick={() => actions.aside.open()}>
              Ask about this part
            </button>
          </p>
        </div>
      </>
    );
  }

  const entries = hopEntries(here);
  const showHop = entries.length > 1 || (entries.length === 1 && !entries[0]!.current);
  const sessionCount = here.sessions.length;
  const hiddenTurn = active?.kind === "retake" ? lastIndex : -1;
  const canRetake = !streaming && turns.length > 0 && turnCursor === lastIndex && active === null;
  const idle = active === null;

  const send = (): void => {
    if (retaking) void actions.aside.submitRetake();
    else void actions.aside.ask();
  };
  const onBoxKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (actions.aside.stop()) return;
      if (retaking) {
        actions.aside.cancelRetake();
        event.currentTarget.closest<HTMLElement>("[data-owns-keys]")?.focus();
        return;
      }
      onClose();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!streaming) send();
    }
  };

  const text = retaking ? retake.text : draft;
  const kept = unsaved.filter((item) => item.storyId === payload.id);
  const nothingToSend = text.trim().length === 0 || !ready || !idle;

  return (
    <>
      <div className="panel-body aside-body">
        <AsideHeading surface={here} turnCount={turns.length} sessionCount={sessionCount} busy={!idle} />
        {showHop && (
          <div className="aside-hop" role="group" aria-label="Asides elsewhere">
            <span className="aside-hop-label">Elsewhere</span>
            {entries.map((entry) => (
              <button
                key={`${entry.anchor.partId}:${entry.anchor.takeId}`}
                type="button"
                className="chip-btn"
                aria-pressed={entry.current}
                title={entry.current ? "This take" : "Go to these asides ([ ])"}
                disabled={!idle}
                onClick={() => actions.aside.hop(entry.anchor)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        {here.load === "loading" && <p className="panel-empty">Loading…</p>}
        {here.load === "failed" && <p className="panel-empty">Aside could not be loaded.</p>}
        {ready && turns.length === 0 && !streaming && (
          <p className="panel-empty">No questions about this take yet. Ask below.</p>
        )}
        <ol className="aside-turns" aria-label="Aside turns">
          {turns.map((turn, index) => {
            if (index === hiddenTurn) return null;
            const selected = index === turnCursor;
            return (
              <li
                key={`${session?.id ?? "none"}:${index}`}
                ref={selected ? selectedRef : undefined}
                className={`aside-turn${selected ? " selected" : ""}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => actions.aside.selectTurn(index)}
              >
                <p className="aside-q">{turn.q}</p>
                <p className="aside-a">{turn.a}</p>
                {selected && (
                  <div className="aside-turn-actions">
                    <AsideUseMenu answer={turn.a} disabled={!idle} />
                    {index === lastIndex && (
                      <>
                        <button
                          type="button"
                          className="btn btn-small btn-ghost"
                          title="Retake this answer (r)"
                          disabled={!canRetake}
                          onClick={() => void actions.aside.retake()}
                        >
                          <Icon path={ICONS.rotate} />
                          Retake
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-ghost"
                          title="Retake with an edited question (R)"
                          disabled={!canRetake}
                          onClick={() => actions.aside.startRetake()}
                        >
                          <Icon path={ICONS.penLine} />
                          Edit question
                        </button>
                      </>
                    )}
                    {index < lastIndex && (
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        title="Drop every turn after this one (Backspace)"
                        disabled={!idle}
                        onClick={() => actions.aside.requestConfirm("reset")}
                      >
                        <Icon path={ICONS.arrowUp} />
                        Reset to here
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      title="Delete this turn (D)"
                      disabled={!idle}
                      onClick={() => actions.aside.requestConfirm("delete")}
                    >
                      <Icon path={ICONS.trash} />
                      Delete
                    </button>
                  </div>
                )}
              </li>
            );
          })}
          {kept.map((item) => (
            <li key={item.id} className="aside-turn aside-unsaved" aria-label="Answer not saved">
              <p className="aside-q">{item.question}</p>
              <p className="aside-a">{item.text}</p>
              <p className="aside-status">Not saved: {item.message}</p>
              <div className="aside-turn-actions">
                <button type="button" className="btn btn-small btn-ghost" title="Copy the text" onClick={() => void actions.aside.copyUnsaved(item.id)}>
                  Copy
                </button>
                <button type="button" className="btn btn-small btn-ghost" title="Discard the text" onClick={() => actions.aside.discardUnsaved(item.id)}>
                  Discard
                </button>
              </div>
            </li>
          ))}
          {streaming && (
            <li ref={liveRef} className="aside-turn aside-live" aria-label="Answer being written">
              <p className="aside-q">{active.question}</p>
              {active.text.length > 0 && <p className="aside-a">{active.text}</p>}
              <p className="aside-status" role="status">{runStatus(active)}</p>
            </li>
          )}
        </ol>
      </div>
      <footer className="panel-foot aside-foot">
        {retaking && <span className="aside-foot-label">Retake with this question</span>}
        <textarea
          ref={boxRef}
          className="facts-input facts-textarea aside-box"
          aria-label={retaking ? "Retake question" : "Ask a question"}
          placeholder="Ask about this take. It stays out of the story."
          rows={2}
          value={text}
          readOnly={!idle}
          aria-busy={streaming}
          onChange={(event) => (retaking ? actions.aside.setRetakeText(event.target.value) : actions.aside.setDraft(event.target.value))}
          onKeyDown={onBoxKeyDown}
        />
        <div className="aside-foot-actions">
          {streaming
            ? (
              <button type="button" className="btn btn-small" title="Stop (Esc)" disabled={active.stopping} onClick={() => actions.aside.stop()}>
                Stop
              </button>
            )
            : (
              <>
                {retaking && (
                  <button type="button" className="btn btn-small btn-ghost" title="Cancel the retake (Esc)" onClick={() => actions.aside.cancelRetake()}>
                    Cancel
                  </button>
                )}
                <button type="button" className="btn btn-small btn-primary" title="Send (Enter)" disabled={nothingToSend} onClick={send}>
                  {retaking ? "Retake" : "Send"}
                </button>
              </>
            )}
        </div>
      </footer>
      {confirm !== null && (() => {
        const copy = confirmText(confirm, turns);
        return (
          <Modal onCancel={actions.aside.dismissConfirm} ariaLabel={copy.title}>
            <h2>{copy.title}</h2>
            <p className="modal-status">{copy.body}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" title="Cancel (Esc)" onClick={actions.aside.dismissConfirm}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={() => void actions.aside.acceptConfirm()}>{copy.action}</button>
            </div>
          </Modal>
        );
      })()}
    </>
  );
}

function AsideHeading(
  { surface, turnCount, sessionCount, busy }: {
    readonly surface: AsideSurface;
    readonly turnCount: number;
    readonly sessionCount: number;
    readonly busy: boolean;
  }
) {
  const { actions } = useAppContext();
  const session = currentSession(surface);
  return (
    <div className="aside-head">
      <div className="aside-heading-row">
        <h2 className="aside-heading">{surfaceHeading(surface)}</h2>
        <span className="aside-badge" title="Aside never changes the story">non-canon</span>
        {surface.anchor !== null && (
          <button
            type="button"
            className="icon-btn"
            title="Go to this take (g)"
            aria-label="Go to this take (g)"
            disabled={busy}
            onClick={actions.aside.goToAnchor}
          >
            <Icon path={ICONS.arrowRight} />
          </button>
        )}
      </div>
      <div className="aside-sessions">
        <button
          type="button"
          className="icon-btn"
          title="Previous session (←)"
          aria-label="Previous session (←)"
          disabled={busy || sessionCount < 2}
          onClick={() => actions.aside.cycleSession(-1)}
        >
          <Icon path={ICONS.chevronLeft} />
        </button>
        <span className="aside-session-label">
          Session {Math.min(surface.sessionIndex + 1, Math.max(1, sessionCount))}/{Math.max(1, sessionCount)}
          {session !== null && session.title.length > 0 && <span className="aside-session-title"> · {session.title}</span>}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Next session (→)"
          aria-label="Next session (→)"
          disabled={busy || sessionCount < 2}
          onClick={() => actions.aside.cycleSession(1)}
        >
          <Icon path={ICONS.chevronRight} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="New session (n)"
          aria-label="New session (n)"
          disabled={busy}
          onClick={actions.aside.newSession}
        >
          <Icon path={ICONS.plus} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Clear this session"
          aria-label="Clear this session"
          disabled={busy || turnCount === 0}
          onClick={() => actions.aside.requestConfirm("clear")}
        >
          <Icon path={ICONS.trash} />
        </button>
      </div>
    </div>
  );
}
