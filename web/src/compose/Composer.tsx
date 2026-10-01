import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useAppContext } from "../app/context.js";
import { resolveComposeBinding } from "../app/keymap-dom.js";
import { useStore } from "../app/store.js";
import { focusCurrentPart } from "../story/focus-dom.js";
import { effectiveFocusedPartId } from "../story/state.js";
import { continuationTargetLabel } from "./target.js";
import { composeDraftOf, isBrowsingHistory, visibleComposeText } from "./state.js";

/**
 * The Direct composer (#409 step 6), the TUI's `i` box: a one-line textarea
 * that grows with its text, above the Continue / Stop button. Enter sends,
 * Shift+Enter adds a line. In retake mode it holds the direction of a new
 * take of one part, under a "Retake part N — new direction" head.
 *
 * The box stays editable while a story writes: only a send is refused, with
 * the draft kept. `children` is the action row `GenerationBar` owns.
 */
export function Composer(
  { storyId, status, children }: {
    readonly storyId: string;
    /** This story's status text ("Writing…"), shown in the head. */
    readonly status: string | null;
    readonly children: ReactNode;
  }
) {
  const { store, actions } = useAppContext();
  const draft = useStore(store, (state) => composeDraftOf(state.compose, storyId));
  const story = useStore(store, (state) => (state.story.kind === "loaded" && state.story.payload.id === storyId ? state.story : null));
  const focusRequest = useStore(store, (state) => state.compose.focusRequest);
  const browsing = isBrowsingHistory(draft);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const seenFocusRequest = useRef(focusRequest);

  // A request to focus the box (Enter or `i` in the manuscript, or `R`).
  // The first value a mount sees is not a request.
  useEffect(() => {
    if (focusRequest === seenFocusRequest.current) return;
    seenFocusRequest.current = focusRequest;
    const field = fieldRef.current;
    if (field === null) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [focusRequest]);

  const text = visibleComposeText(draft);
  const retakeNumber = story !== null && draft.retake !== null
    ? story.payload.path.findIndex((node) => node.id === draft.retake?.nodeId) + 1
    : 0;
  const head = draft.retake === null
    ? (story === null ? "" : continuationTargetLabel(story.payload, effectiveFocusedPartId(story), text))
    : (retakeNumber > 0 ? `Retake part ${retakeNumber} — new direction` : "Retake — that part is no longer on the line");

  /** Hands the keyboard back to the manuscript. */
  const leave = (): void => {
    fieldRef.current?.blur();
    focusCurrentPart();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // An input method is composing text: Enter and Escape belong to it.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Load-bearing: without it the window listener in `app/keymap.ts` would
      // also stop a running generation on this same press.
      event.preventDefault();
      if (draft.retake !== null) actions.compose.cancelRetake(storyId);
      leave();
      return;
    }
    const chord = resolveComposeBinding(event.nativeEvent);
    if (chord?.action === "history-previous" || chord?.action === "history-next") {
      event.preventDefault();
      actions.compose.historyMove(storyId, chord.action === "history-previous" ? -1 : 1);
      return;
    }
    const plain = !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
    if (event.key === "Enter" && plain) {
      event.preventDefault();
      if (actions.compose.submit(storyId)) leave();
      return;
    }
    // ⌃↑ is Mission Control on macOS, so plain ↑ and ↓ walk the history when
    // the box is empty, or when a walk is on and the text is one line.
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain
      && (text.length === 0 || (browsing && !text.includes("\n")))) {
      event.preventDefault();
      actions.compose.historyMove(storyId, event.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <div className="composer">
      <div className="composer-head">
        <span className="composer-target">{head}</span>
        {status !== null && status.length > 0 && <span className="generation-status">{status}</span>}
      </div>
      <div className="composer-row">
        <textarea
          ref={fieldRef}
          className="composer-field"
          rows={1}
          value={text}
          placeholder={draft.retake === null ? "What happens next?" : "How should this part go instead?"}
          aria-label={draft.retake === null ? "What happens next?" : "New direction for the retake"}
          title="Enter sends. Shift+Enter adds a line."
          aria-keyshortcuts="Enter"
          spellCheck
          onChange={(event) => actions.compose.setText(storyId, event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="generation-bar-actions">{children}</div>
      </div>
    </div>
  );
}

/** Used by the Continue button: sends the box, then hands the keyboard back. */
export function useSendFromButton(storyId: string): () => void {
  const { actions } = useAppContext();
  return () => {
    if (actions.compose.submit(storyId)) focusCurrentPart();
  };
}
