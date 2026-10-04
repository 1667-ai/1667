import { useEffect } from "react";
import { formatTokensScaled } from "../../../shared/rail-model.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { thoughtUnfolded } from "./thoughts.js";

/**
 * A landed take's thought, under its part header: a ghost "Thought" button
 * that unfolds the stored text beside a rail. The thought of text that is
 * still streaming is never shown (owner decision 5), so a part that a live
 * append is growing shows nothing here.
 */
export function ThoughtBlock({ storyId, partId, streaming }: { readonly storyId: string; readonly partId: string; readonly streaming: boolean }) {
  const { store, actions } = useAppContext();
  const reasoning = useStore(store, (state) => state.context.runtime?.runtime.reasoning ?? "marker");
  const unfolded = useStore(store, (state) => thoughtUnfolded(reasoning, state.thoughts.flipped, partId));
  const entry = useStore(store, (state) => state.thoughts.entries[partId]);
  const visible = reasoning !== "off" && !streaming;

  useEffect(() => {
    if (visible && unfolded) actions.thoughts.ensureLoaded(storyId, partId);
  }, [visible, unfolded, storyId, partId, actions]);

  if (!visible) return null;
  const tokens = entry?.status === "ready" && entry.record.tokenCount > 0 ? ` · ${formatTokensScaled(entry.record.tokenCount)}` : "";
  return (
    <div className="thought">
      <button
        type="button"
        className="thought-toggle"
        aria-expanded={unfolded}
        title={unfolded ? "Hide the thought (T)" : "Show the thought (T)"}
        onClick={() => actions.thoughts.toggle(partId)}
      >
        Thought{unfolded ? tokens : ""}
      </button>
      {unfolded && (
        <div className="thought-body" role="region" aria-label="Thought">
          {entry === undefined || entry.status === "loading"
            ? <p className="thought-note">Loading the thought…</p>
            : entry.status === "error"
              ? <p className="thought-note">Could not load the thought.</p>
              : <p className="thought-text">{entry.record.text}</p>}
        </div>
      )}
    </div>
  );
}
