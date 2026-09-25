import { useEffect } from "react";
import { countWords } from "../../../shared/story-text.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { storyIdOf } from "./state.js";

/**
 * `#/story/:id` for step 3: title, stats, and the active path's plain text —
 * read-only, clearly a placeholder. Steps 4+ replace this with the real
 * manuscript view (streaming, retake/edit, tags/chapters/facts, map).
 *
 * Review fix B3: a failed `loadStory` (e.g. a route naming a story someone
 * just deleted) used to leave this on "Loading…" forever, because
 * `state.openStory: StoryPayload | null` had no way to represent "this id
 * does not exist". `state.story`'s `missing` variant is that state.
 */
export function StoryPlaceholder({ storyId }: { readonly storyId: string }) {
  const { store, actions } = useAppContext();
  const story = useStore(store, (state) => (storyIdOf(state.story) === storyId ? state.story : null));

  useEffect(() => {
    void actions.story.load(storyId);
  }, [storyId, actions]);

  if (story === null || story.kind === "idle" || story.kind === "loading") {
    return <p className="story-empty">Loading…</p>;
  }

  if (story.kind === "missing") {
    return (
      <div className="welcome">
        <h1>This story no longer exists</h1>
        <p>It may have been deleted in another tab, or its link was old.</p>
        <a className="btn btn-primary" href="#/">Back to the Library</a>
      </div>
    );
  }

  const payload = story.payload;
  const words = payload.path.reduce((total, node) => total + countWords(node.text), 0);
  const activeText = payload.path.map((node) => node.text).join("");

  return (
    <div className="story-view">
      <header className="story-header">
        <div className="story-identity">
          <span className="story-kicker">Placeholder — step 4 replaces this view</span>
          <div className="story-title-wrap">
            <h1 className="story-title">{payload.title}</h1>
          </div>
          <span className="story-stats">
            {payload.path.length} {payload.path.length === 1 ? "part" : "parts"} ·{" "}
            {words.toLocaleString()} words
          </span>
        </div>
      </header>
      <div className="story-main">
        <div className="story-scroll">
          <div className="story-body">
            {activeText.length === 0
              ? <p className="story-empty">This story has no text yet.</p>
              : <p className="prose-plain">{activeText}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
