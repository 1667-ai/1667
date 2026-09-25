import { useEffect } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";

/**
 * `#/story/:id` for step 3: title, stats, and the active path's plain text —
 * read-only, clearly a placeholder. Steps 4+ replace this with the real
 * manuscript view (streaming, retake/edit, tags/chapters/facts, map).
 */
export function StoryPlaceholder({ storyId }: { readonly storyId: string }) {
  const { store, actions } = useAppContext();
  const payload = useStore(store, (state) => (
    state.openStory !== null && state.openStory.id === storyId ? state.openStory : null
  ));

  useEffect(() => {
    void actions.library.openStory(storyId);
  }, [storyId, actions]);

  if (payload === null) {
    return <p className="story-empty">Loading…</p>;
  }

  const words = payload.path.reduce((total, node) => total + wordCount(node.text), 0);
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

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}
