import { useCallback, useEffect, useRef, useState } from "react";
import type { StoryApi } from "../../../client/api.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { runBusyToast } from "../app/run-lock.js";
import { useStore } from "../app/store.js";
import { InspectChrome } from "../inspect/InspectPage.js";
import { useInspectKeys } from "../inspect/keys.js";
import { ContinuationText } from "./ContinuationText.js";
import { keepPreview } from "./keep.js";
import { Knob } from "./Knob.js";
import { createPreviewSource } from "./preview-source.js";
import { BUFFER_WORDS } from "./steer-session.js";
import { formatStatus, trimContext } from "./status.js";
import { useKnobDrag } from "./useKnobDrag.js";
import { useSteerKeys } from "./keys.js";
import { useSteerSession } from "./useSteerSession.js";

export const NOT_AVAILABLE_TEXT = "Steer is not available on this server.";

type PreviewingApi = StoryApi & Required<Pick<StoryApi, "previewContinuation">>;

/**
 * `#/story/<id>/steer`: a live continuation of the story line, shown up to a
 * knob. Scrub the knob to read ahead or to go back and write it again. Keep
 * saves the shown words as a new part. Nothing else is saved.
 */
export function SteerPage(
  { storyId, payload, onOpenSidebar, onClose }: {
    readonly storyId: string;
    readonly payload: StoryPayload;
    readonly onOpenSidebar: () => void;
    readonly onClose: () => void;
  }
) {
  const { store } = useAppContext();
  const api = useStore(store, (state) => (state.connection.kind === "connected" ? state.connection.api : null));
  // The web UI runs one provider call at a time, in any story.
  const busy = useStore(store, (state) => runBusyToast(state, storyId));
  const lineEnd = payload.path.at(-1);
  let content;
  if (api === null || api.previewContinuation === undefined) content = <SteerMessage text={NOT_AVAILABLE_TEXT} onClose={onClose} />;
  else if (busy !== null) content = <SteerMessage text={busy} onClose={onClose} />;
  else if (lineEnd === undefined) content = <SteerMessage text="This story has no part yet." onClose={onClose} />;
  else content = <SteerBody storyId={storyId} payload={payload} api={api as PreviewingApi} lineEnd={lineEnd} onClose={onClose} />;
  return (
    <InspectChrome
      storyTitle={payload.title}
      title="Steer"
      detail="Scrub a preview. Keep saves the shown words."
      onOpenSidebar={onOpenSidebar}
      onClose={onClose}
    >
      {content}
    </InspectChrome>
  );
}

function SteerMessage({ text, onClose }: { readonly text: string; readonly onClose: () => void }) {
  useInspectKeys(onClose, () => false);
  return <p className="request-empty">{text}</p>;
}

function SteerBody(
  { storyId, payload, api, lineEnd, onClose }: {
    readonly storyId: string;
    readonly payload: StoryPayload;
    readonly api: PreviewingApi;
    readonly lineEnd: StoryPayload["path"][number];
    readonly onClose: () => void;
  }
) {
  const { store, actions } = useAppContext();
  // The preview belongs to the line end it started from; a later change to the story does not move it.
  const [parentId] = useState(lineEnd.id);
  const [known] = useState(() => new Set(payload.nodes.map((node) => node.id)));
  const [source] = useState(() => createPreviewSource(api, storyId, parentId));
  const { session, snapshot } = useSteerSession(source);
  const textRef = useRef<HTMLParagraphElement>(null);
  const knobRef = useRef<HTMLButtonElement>(null);
  const keeping = useRef(false);
  // Esc or Back can close the page while Keep waits for the save.
  const mounted = useRef(true);
  const drag = useKnobDrag(textRef, session.moveTo);

  useEffect(() => knobRef.current?.focus(), []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const keep = useCallback(async () => {
    const text = session.shownText();
    if (keeping.current || text.length === 0) return;
    keeping.current = true;
    session.dispose();
    const saved = await keepPreview(store, actions, api, storyId, parentId, text, known);
    keeping.current = false;
    if (!saved && mounted.current) session.start();
  }, [session, store, actions, api, storyId, parentId, known]);
  useSteerKeys(onClose, () => { void keep(); });

  return (
    <div className="steer-column">
      <h2 className="steer-label">Context</h2>
      <p className="steer-context">{trimContext(lineEnd.text)}</p>
      <h2 className="steer-label">Continuation</h2>
      <ContinuationText
        text={snapshot.text}
        shown={snapshot.shown}
        textRef={textRef}
        knobRef={knobRef}
        onPickWord={session.moveTo}
        knob={(
          <Knob
            knobRef={knobRef}
            shown={snapshot.shown}
            generated={snapshot.generated}
            buffer={Math.min(1, snapshot.ahead / BUFFER_WORDS)}
            generating={snapshot.generating}
            dragging={drag.dragging}
            onMove={session.moveTo}
            pointer={drag.handlers}
          />
        )}
      />
      {/* The words ahead of the knob are hidden but keep their place, so the
          column grows with the buffer: the footer stays in view at the bottom. */}
      <div className="steer-footer">
        <p className="steer-status">{formatStatus(snapshot)}</p>
        {snapshot.error !== null && <p className="steer-error" role="alert">{snapshot.error}</p>}
        <div className="steer-actions">
          <button
            type="button"
            className="btn btn-primary"
            title="Save the shown words as a new part (Enter)"
            aria-keyshortcuts="Enter"
            disabled={snapshot.shown === 0}
            onClick={() => { void keep(); }}
          >
            Keep
          </button>
          <button type="button" className="btn" title="Close without saving (Esc)" aria-keyshortcuts="Escape" onClick={onClose}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
