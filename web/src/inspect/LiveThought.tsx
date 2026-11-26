import { useLayoutEffect, useRef } from "react";
import { formatTokensScaled } from "../../../shared/rail-model.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import type { GenerationReasoning } from "../generation/state.js";
import { thoughtUnfolded } from "./thoughts.js";

/** How close to the end, in pixels, still counts as reading the end. */
const FOLLOW_SLACK_PX = 24;

/**
 * The thought of a take that is still streaming, under its part header (`T`
 * in the TUI). It folds and unfolds the same way as a landed take's
 * `ThoughtBlock`. A new take's thought folds again when the take lands; an
 * append keeps its part's fold. An open thought follows the new text to its
 * end, until the reader scrolls up to read; a scroll back to the end follows
 * again.
 */
export function LiveThought({ thoughtId, reasoning, live }: {
  readonly thoughtId: string;
  readonly reasoning: GenerationReasoning;
  readonly live: boolean;
}) {
  const { store, actions } = useAppContext();
  const display = useStore(store, (state) => state.context.runtime?.runtime.reasoning ?? "marker");
  const unfolded = useStore(store, (state) => thoughtUnfolded(display, state.thoughts.flipped, thoughtId));
  const body = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = body.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [reasoning.text, unfolded]);

  if (display === "off") return null;
  const tokens = reasoning.tokenCount > 0 ? ` · ${formatTokensScaled(reasoning.tokenCount)}` : "";
  return (
    <div className="thought">
      <button
        type="button"
        className="thought-toggle"
        aria-expanded={unfolded}
        title={unfolded ? "Hide the thought (T)" : "Show the thought (T)"}
        onClick={() => actions.thoughts.toggle(thoughtId)}
      >
        Thought{tokens}{live ? " …" : ""}
      </button>
      {unfolded && (
        <div
          ref={body}
          className="thought-body thought-body-live"
          role="region"
          aria-label="Thought"
          onScroll={(event) => {
            const element = event.currentTarget;
            following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
          }}
        >
          <p className="thought-text">{reasoning.text}</p>
        </div>
      )}
    </div>
  );
}
