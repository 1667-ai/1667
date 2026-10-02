import { useEffect, useRef } from "react";
import { useAppContext } from "../app/context.js";
import { activatesOnEnterOrSpace } from "../app/keymap-dom.js";
import { registerScreenKeys } from "../app/keymap.js";
import { navigate, openMap } from "../app/router.js";
import { useStore } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { PartEditor } from "../editor/PartEditor.js";
import { Composer } from "../compose/Composer.js";
import { EditorRecovery } from "../editor/EditorRecovery.js";
import { editorIsOffLine, editorPartId } from "../editor/state.js";
import { GenerationButtons, generationStatusText } from "../generation/GenerationBar.js";
import { manuscriptGenerationView, type ManuscriptGeneration } from "../generation/state.js";
import { useFollowStream } from "../generation/useFollowStream.js";
import { useBarClearance } from "../ui/bar-clearance.js";
import { SidebarToggle } from "../ui/SidebarToggle.js";
import { focusCurrentPart, focusPartElement } from "./focus-dom.js";
import { Manuscript } from "./Manuscript.js";
import { PruneDialog } from "./PruneDialog.js";
import { StoryHeader } from "./StoryHeader.js";
import { handleWritingKey } from "./writing-keys.js";
import { effectiveFocusedPartId, storyIdOf, type StoryState } from "./state.js";

/** The `role="status"` region's text: a running/settling generation's own
 * status label wins while it targets this exact story and is still live
 * (never per token — this only actually changes value at the
 * Thinking/Writing boundary, since the presented text is already
 * throttled; a frozen `"unsaved"` leftover falls through to the story's
 * own announcement instead of claiming it is still writing — review fix
 * #10 folds this and the bar's own status text into one shared
 * `statusLabel`, computed once by `manuscriptGenerationView`); otherwise
 * the story's own last announcement (a landed take switch, or a generation
 * that just landed — `story/actions.ts`'s `adoptPayload` sets both a
 * payload and this text in the same store update, so a landing narrates
 * itself the instant it lands, with no separate wiring here). */
function liveRegionText(story: Extract<StoryState, { kind: "loaded" }>, generationView: ManuscriptGeneration | null): string {
  if (generationView !== null && generationView.live) return generationView.statusLabel;
  return story.announcement ?? "";
}

const NOTHING_TO_MAP_TOAST = "Nothing to map yet.";

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
export function StoryView(
  { storyId, onOpenSidebar }: { readonly storyId: string; readonly onOpenSidebar: () => void }
) {
  const { store, actions } = useAppContext();
  const story = useStore(store, (state) => (storyIdOf(state.story) === storyId ? state.story : null));
  const showDirections = useStore(store, (state) => state.reading.showDirections);
  const generation = useStore(store, (state) => state.generation);
  // Primitives and stable references only: this view must not redraw on every
  // change to the editor's text or the menu's state.
  const editingPartId = useStore(store, (state) => (
    state.editor !== null && state.editor.storyId === storyId ? editorPartId(state.editor) : null
  ));
  const editorIsFirst = useStore(store, (state) => (
    state.editor !== null && state.editor.storyId === storyId && state.editor.mode === "first"
  ));
  const editorOffLine = useStore(store, (state) => editorIsOffLine(state, storyId));
  const menuRequest = useStore(store, (state) => state.partUi.menuRequest);
  const deletePlan = useStore(store, (state) => (
    state.partUi.deletePlan !== null && state.partUi.deletePlan.storyId === storyId ? state.partUi.deletePlan : null
  ));
  const deleting = useStore(store, (state) => state.partUi.deleting);
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useBarClearance();
  const focusedPartId = story !== null && story.kind === "loaded" ? effectiveFocusedPartId(story) : null;
  const generationView = manuscriptGenerationView(generation, storyId);

  // Sticks to the bottom while this story's own generation streams; a
  // reader who scrolls up (to reread, or to keep an earlier part in view)
  // un-pins it until they scroll back down themselves.
  useFollowStream(scrollRef, generationView?.live === true, generationView?.text);

  useEffect(() => {
    void actions.story.load(storyId);
  }, [storyId, actions]);

  // Leaving the story with the delete dialog open must not bring it back.
  useEffect(() => () => actions.part.cancelDelete(), [storyId, actions]);

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
  useEffect(() => registerScreenKeys((binding, event) => {
    // `app/keymap.ts`'s own listener already refuses to call a registered
    // handler at all while `fieldHasFocus()` is true — checking it again
    // here was dead code (it can never be true by the time this runs).
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
      case "continue": {
        // `shared/reference-bindings.ts`'s "space" binding carries no `shift`
        // field, so a Shift+Space keypress resolves here too — Shift+Space
        // must keep the browser's own scroll, so it is refused explicitly
        // rather than treated as a plain Continue. A repeat (held key) and a
        // focused take-switch arrow/counter (Enter/Space already activate
        // those) are refused the same way. `continue()` itself now owns the
        // "already writing" refusal and its toast (review fix #9) — this
        // screen only filters the key and calls it, so step 6's composer
        // submit can reuse the exact same call without repeating that logic.
        if (event.shiftKey || event.repeat || activatesOnEnterOrSpace()) return false;
        const from = effectiveFocusedPartId(current.story);
        if (from === null) void actions.generation.continue();
        else actions.part.run("continue", from);
        return true;
      }
      case "scroll-line-up": return scrollBy(container, -LINE_SCROLL_PX);
      case "scroll-line-down": return scrollBy(container, LINE_SCROLL_PX);
      case "scroll-up": return scrollBy(container, -pageScrollDistance(container));
      case "scroll-down": return scrollBy(container, pageScrollDistance(container));
      case "open-library": navigate({ kind: "library" }); return true;
      case "open-map":
        if (current.story.payload.nodes.length === 0) pushToast(store, NOTHING_TO_MAP_TOAST);
        else openMap(storyId);
        return true;
      default: return handleWritingKey(binding, event, current.story, actions);
    }
  }), [actions, store, storyId]);

  if (story === null || story.kind === "idle" || story.kind === "loading") {
    return (
      <>
        <div className="main-toolbar"><SidebarToggle onOpen={onOpenSidebar} /></div>
        <p className="story-empty">Loading…</p>
      </>
    );
  }

  if (story.kind === "missing") {
    return (
      <>
        <div className="main-toolbar"><SidebarToggle onOpen={onOpenSidebar} /></div>
        <div className="welcome">
          <h1>This story no longer exists</h1>
          <p>It may have been deleted in another tab, or its link was old.</p>
          <a className="btn btn-primary" href="#/">Back to the Library</a>
        </div>
      </>
    );
  }

  const payload = story.payload;

  return (
    <div className="story-view">
      <StoryHeader
        payload={payload}
        showDirections={showDirections}
        onToggleDirections={actions.story.toggleDirections}
        onOpenSidebar={onOpenSidebar}
        onOpenMap={() => openMap(storyId)}
      />
      <div className="story-main">
        <div className="story-scroll" ref={scrollRef}>
          <div className="story-body">
            {editorOffLine && <EditorRecovery />}
            {payload.path.length === 0 && generationView === null
              ? (editorIsFirst
                ? (
                  <article className="part" aria-label="Part 1">
                    <div className="part-header"><span className="part-number">Part 1</span></div>
                    <PartEditor partNumber={1} showDirections={false} />
                  </article>
                )
                : <p className="story-empty">This story has no text yet. Press w to write the first part.</p>)
              : (
                <Manuscript
                  payload={payload}
                  focusedPartId={focusedPartId}
                  switching={story.switching}
                  showDirections={showDirections}
                  editingPartId={editingPartId}
                  menuRequest={menuRequest}
                  generation={generationView}
                  onFocusPart={actions.story.focusPart}
                  onSwitch={actions.story.switchTake}
                  onSwitchTo={actions.story.switchTakeTo}
                />
              )}
          </div>
        </div>
        <div ref={barRef} className={`generation-bar generation-bar-compose${generation.kind === "unsaved" ? " generation-bar-unsaved" : ""}`}>
          <Composer storyId={storyId} status={generationStatusText(generation, storyId)}>
            <GenerationButtons onContinue={() => { if (actions.compose.submit(storyId)) focusCurrentPart(); }} />
          </Composer>
        </div>
      </div>
      {deletePlan !== null && (
        <PruneDialog
          plan={deletePlan}
          deleting={deleting}
          onCancel={actions.part.cancelDelete}
          onDelete={() => void actions.part.confirmDelete()}
        />
      )}
      <div role="status" className="sr-only">{liveRegionText(story, generationView)}</div>
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
