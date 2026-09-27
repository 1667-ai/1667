import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import type { GenerationState } from "./state.js";

/**
 * The bottom bar for Continue/Stop (#409 step 5) — mounted twice: at the
 * bottom of the open story's own main area (`StoryView.tsx`), and at the
 * library route (`App.tsx`'s `Shell`, only while a generation is running
 * somewhere) so "one web generation at a time" always has a visible Stop
 * from wherever the reader is (owner decision 2). `viewingStoryId` is the
 * story this particular mount belongs to — `null` for the library mount,
 * which never offers a Continue CTA of its own (there is no focused part to
 * continue from on that route).
 *
 * Look ported from StoryTavern's `ComposerFooter` (`btn-primary btn-cta`,
 * `btn-danger btn-cta`) — see `styles/generation.css`/`styles/buttons.css`.
 */
export function GenerationBar({ viewingStoryId }: { readonly viewingStoryId: string | null }) {
  const { store, actions } = useAppContext();
  const generation = useStore(store, (state) => state.generation);

  if (generation.kind === "idle") {
    if (viewingStoryId === null) return null;
    return (
      <div className="generation-bar">
        <button
          type="button"
          className="btn btn-primary btn-cta"
          aria-keyshortcuts="Space"
          onClick={() => { void actions.generation.continue(); }}
        >
          Continue
        </button>
      </div>
    );
  }

  const inThisStory = generation.storyId === viewingStoryId;
  const status = statusText(generation, inThisStory);

  if (generation.kind === "unsaved") {
    return (
      <div className="generation-bar generation-bar-unsaved">
        <span className="generation-status">{status}</span>
        <div className="generation-bar-actions">
          <button type="button" className="btn" onClick={() => { void actions.generation.copyUnsaved(); }}>
            Copy
          </button>
          <button type="button" className="btn btn-danger" onClick={actions.generation.discardUnsaved}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="generation-bar">
      <span className="generation-status">{status}</span>
      {generation.kind === "settling"
        ? <button type="button" className="btn btn-primary btn-cta" disabled>Saving…</button>
        : (
          <button
            type="button"
            className="btn btn-danger btn-cta"
            aria-keyshortcuts="Escape"
            onClick={actions.generation.stop}
          >
            Stop
          </button>
        )}
    </div>
  );
}

function statusText(generation: Exclude<GenerationState, { kind: "idle" }>, inThisStory: boolean): string {
  if (generation.kind === "unsaved") {
    return inThisStory ? "Not saved" : `Not saved in ${generation.storyTitle}`;
  }
  const thinking = generation.reasoning !== null && generation.text.length === 0;
  if (!inThisStory) return `Writing in ${generation.storyTitle}…`;
  return thinking ? "Thinking…" : "Writing…";
}
