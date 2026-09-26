import { useEffect, useRef } from "react";
import { useAppContext } from "../app/context.js";
import { fieldHasFocus } from "../app/keymap-dom.js";
import { registerScreenKeys } from "../app/keymap.js";
import { navigate } from "../app/router.js";
import { useStore } from "../app/store.js";
import { focusPartElement } from "./focus-dom.js";
import { Manuscript } from "./Manuscript.js";
import { StoryHeader } from "./StoryHeader.js";
import { effectiveFocusedPartId, storyIdOf } from "./state.js";

/** Roughly one prose line at the default size — `⇧↑`/`⇧↓`'s nudge. */
const LINE_SCROLL_PX = 60;

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

  // The TUI keys this screen handles now: focus prev/next, take prev/next
  // (also while a take-switch button has focus — buttons are not "fields"),
  // top/leaf, chapter prev/next, toggle directions, scroll by line/page, and
  // open the Library. Everything else in the shared table resolves to
  // nothing here and keeps its native browser behavior. Reads `store.get()`
  // fresh on every keypress rather than closing over `story`/`focusedPartId`,
  // so one registration (mount-only) never goes stale across a switch or a
  // focus move.
  useEffect(() => registerScreenKeys((binding) => {
    if (fieldHasFocus()) return false;
    const current = store.get();
    if (current.route.kind !== "story" || current.route.id !== storyId) return false;
    if (current.story.kind !== "loaded") return false;
    const container = scrollRef.current;
    switch (binding.action) {
      case "focus-previous": actions.story.moveFocus(-1); return true;
      case "focus-next": actions.story.moveFocus(1); return true;
      case "top": actions.story.focusFirst(); return true;
      case "leaf": actions.story.focusLast(); return true;
      case "chapter-previous": actions.story.jumpChapter(-1); return true;
      case "chapter-next": actions.story.jumpChapter(1); return true;
      case "toggle-instructions": actions.story.toggleDirections(); return true;
      case "take-previous":
      case "take-next": {
        const target = effectiveFocusedPartId(current.story);
        if (target === null) return false;
        actions.story.switchTake(target, binding.action === "take-next" ? 1 : -1);
        return true;
      }
      case "scroll-line-up": return scrollBy(container, -LINE_SCROLL_PX);
      case "scroll-line-down": return scrollBy(container, LINE_SCROLL_PX);
      case "scroll-up": return scrollBy(container, -pageScrollDistance(container));
      case "scroll-down": return scrollBy(container, pageScrollDistance(container));
      case "open-library": navigate({ kind: "library" }); return true;
      default: return false;
    }
  }), [actions, store, storyId]);

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
                  onSwitchTo={actions.story.switchTakeTo}
                />
              )}
          </div>
        </div>
      </div>
      <div role="status" className="sr-only">{story.announcement}</div>
    </div>
  );
}

/** `false` when there is no scroll container yet (nothing to scroll, so the
 * key resolves to nothing rather than being reported as handled). */
function scrollBy(container: HTMLElement | null, deltaY: number): boolean {
  if (container === null) return false;
  container.scrollBy({ top: deltaY });
  return true;
}

/** ~90% of the viewport, so a page scroll always leaves a line of context
 * behind — the same "don't lose your place" reasoning as a book's own page
 * turn, and analogous to the TUI's own page step. */
function pageScrollDistance(container: HTMLElement | null): number {
  return container === null ? 0 : Math.round(container.clientHeight * 0.9);
}
