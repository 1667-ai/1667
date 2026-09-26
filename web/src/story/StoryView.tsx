import { useEffect, useRef } from "react";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { focusPartElement } from "./focus-dom.js";
import { Manuscript } from "./Manuscript.js";
import { StoryHeader } from "./StoryHeader.js";
import { effectiveFocusedPartId, storyIdOf } from "./state.js";

/**
 * `#/story/:id`'s manuscript read view (#409 step 4): the active line as
 * parts, part focus, take switching, and — from step 6 on — the TUI's own
 * keys. Replaces the step-3 placeholder (`StoryPlaceholder.tsx`, now
 * deleted); writing/generation (steps 5–6 of the original plan, now folded
 * into later work) still do not exist.
 *
 * Review fix B3 (inherited from the placeholder): a failed `loadStory`
 * (e.g. a route naming a story someone just deleted) used to leave this on
 * "Loading…" forever, because `state.story`'s `missing` variant is what
 * renders instead.
 */
export function StoryView({ storyId }: { readonly storyId: string }) {
  const { store, actions } = useAppContext();
  const story = useStore(store, (state) => (storyIdOf(state.story) === storyId ? state.story : null));
  const showDirections = useStore(store, (state) => state.reading.showDirections);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusedPartId = story !== null && story.kind === "loaded" ? effectiveFocusedPartId(story) : null;

  useEffect(() => {
    void actions.story.load(storyId);
  }, [storyId, actions]);

  // Moves DOM focus (not just the store's notion of it) whenever the
  // effective focused part changes — landing a switch, a keyboard move, or
  // opening the story at its stored/opening position all funnel through
  // this one effect. `focus-dom.ts` itself refuses to steal focus from
  // search or a dialog.
  useEffect(() => {
    if (focusedPartId === null || scrollRef.current === null) return;
    focusPartElement(scrollRef.current, focusedPartId);
  }, [focusedPartId]);

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

  return (
    <div className="story-view">
      <StoryHeader
        payload={payload}
        showDirections={showDirections}
        onToggleDirections={actions.story.toggleDirections}
      />
      <div className="story-main">
        <div className="story-scroll" ref={scrollRef}>
          <div className="story-body">
            {payload.path.length === 0
              ? <p className="story-empty">This story has no text yet.</p>
              : (
                <Manuscript
                  payload={payload}
                  focusedPartId={focusedPartId}
                  switching={story.switching}
                  showDirections={showDirections}
                  onFocusPart={actions.story.focusPart}
                  onSwitch={actions.story.switchTake}
                />
              )}
          </div>
        </div>
      </div>
      <div role="status" className="sr-only">{story.announcement}</div>
    </div>
  );
}
