import { useEffect } from "react";
import { useAppContext } from "../app/context.js";
import { registerScreenKeys } from "../app/keymap.js";
import { openSettings } from "../app/router.js";
import { useStore } from "../app/store.js";

/** Moved out of `App.tsx` (review fix B6): the main pane's content on
 * `#/` — a loading state, an empty-library welcome, or the totals. */
export function LibraryHome() {
  const { store } = useAppContext();
  const stories = useStore(store, (state) => state.library.stories);
  // `,` opens the settings page; the Library has no other screen keys.
  useEffect(() => registerScreenKeys((binding) => {
    if (binding.action !== "open-settings") return false;
    openSettings();
    return true;
  }), []);
  if (stories === null) {
    return <p className="story-empty">Loading your library…</p>;
  }
  if (stories.length === 0) {
    return (
      <div className="welcome">
        <h1>No stories yet</h1>
        <p>Create one to start writing.</p>
      </div>
    );
  }
  const words = stories.reduce((total, story) => total + story.words, 0);
  return (
    <div className="welcome">
      <h1>1667</h1>
      <p>
        {stories.length} {stories.length === 1 ? "story" : "stories"} ·{" "}
        {words.toLocaleString()} words
      </p>
    </div>
  );
}
