import { canonicalFactStates } from "../../../shared/fact-state.js";
import { resolveRerouteTarget } from "../../../shared/path-layout.js";
import type { SearchHit } from "../../../shared/story-search.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { AppActions } from "../app/actions.js";
import { navigate } from "../app/router.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { pushToast } from "../app/toasts.js";
import { focusCurrentPart } from "../story/focus-dom.js";

const STORY_LOAD_TIMEOUT_MS = 15_000;

/** Whether the hit still names something in the story as loaded. This asks
 * whether the destination exists, not whether its prose still says the same:
 * an edited part is still the part the writer asked for. */
function hitSurvivesIn(hit: SearchHit, payload: StoryPayload): boolean {
  if (hit.kind !== "fact") return payload.nodes.some((node) => node.id === hit.targetId);
  const fact = payload.facts.find(({ id }) => id === hit.targetId);
  return fact !== undefined
    && (hit.stateId === undefined || canonicalFactStates(fact).some(({ id }) => id === hit.stateId));
}

/** Resolves with the story once it is loaded and on the route, or `null` when it is missing or slow. */
function whenStoryLoaded(store: Store<AppState>, id: string): Promise<StoryPayload | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => {};
    const settle = (payload: StoryPayload | null): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    };
    const check = (): boolean => {
      const { story, route } = store.get();
      // The route changes on the hash event, a moment after `navigate`.
      if (route.kind !== "story" || route.id !== id) return false;
      if (story.kind === "loaded" && story.payload.id === id) { settle(story.payload); return true; }
      if (story.kind === "missing" && story.id === id) { settle(null); return true; }
      return false;
    };
    if (check()) return;
    unsubscribe = store.subscribe(check);
    timer = setTimeout(() => settle(null), STORY_LOAD_TIMEOUT_MS);
  });
}

/**
 * Enter on a hit, as the TUI does it: a hit in another story opens that story
 * first; a prose or prompt hit goes through the line switch (and its refusals)
 * and takes focus; a Fact hit opens the Facts panel on that Fact and state.
 * The dialog closes when the hit lands; a refusal keeps it open.
 */
export async function openSearchHit(
  hit: SearchHit,
  store: Store<AppState>,
  actions: AppActions,
  closeDialog: () => void
): Promise<void> {
  let payload: StoryPayload;
  let navigated = false;
  // Leaving the story unmounts the dialog's content; a failed open must still clear the overlay.
  const refuse = (message: string): void => {
    pushToast(store, message);
    if (navigated) closeDialog();
  };
  const current = store.get().story;
  if (current.kind === "loaded" && current.payload.id === hit.storyId) {
    payload = current.payload;
  } else {
    navigated = true;
    navigate({ kind: "story", id: hit.storyId });
    const loaded = await whenStoryLoaded(store, hit.storyId);
    if (loaded === null) {
      refuse("That story could not be opened.");
      return;
    }
    payload = loaded;
  }
  if (!hitSurvivesIn(hit, payload)) {
    const fact = hit.kind === "fact" && payload.facts.some(({ id }) => id === hit.targetId);
    refuse(fact ? "That Fact State is no longer in this story." : "That part is no longer in this story.");
    return;
  }
  if (hit.kind === "fact") {
    // The dialog gives the keyboard back to the page as it closes; the panel takes it after that.
    closeDialog();
    setTimeout(() => {
      actions.facts.open(hit.targetId);
      if (hit.stateId !== undefined) actions.facts.openState(hit.stateId);
    }, 0);
    return;
  }
  const target = resolveRerouteTarget(payload, hit.targetId);
  if (target === null) {
    refuse("That part is no longer in this story.");
    return;
  }
  if (!actions.story.switchLine(target)) return;
  closeDialog();
  setTimeout(focusCurrentPart, 0);
}
