import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import type { StoryPayload } from "../../../shared/types.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { catchAtBoundary, runAction } from "../app/toasts.js";
import type { StoryState } from "./state.js";

export interface StoryActions {
  load(id: string): Promise<void>;
  /** `library/actions.ts` calls this after a successful rename instead of
   * writing `state.story` itself — this slice owns its own shape (review fix
   * B3/B5). `renameStory` returns the full, fresh `StoryPayload`, so this
   * replaces the whole thing when it is the one currently open, the same as
   * the pre-split code did for `state.openStory`. */
  titleChanged(updated: StoryPayload): void;
}

function requireApi(store: Store<AppState>): StoryApi {
  const connection = store.get().connection;
  if (connection.kind !== "connected") throw new Error("1667 web: not connected");
  return connection.api;
}

/** Stale responses: only adopt a result for `id` if the route still names
 * it — a fast second click on another row must not have this (slower)
 * response land after the user already moved on. */
function setStoryIfCurrentRoute(store: Store<AppState>, id: string, next: StoryState): void {
  store.set((state) => (
    state.route.kind === "story" && state.route.id === id ? { ...state, story: next } : state
  ));
}

export function createStoryActions(store: Store<AppState>): StoryActions {
  return {
    load: (id) => catchAtBoundary(() => runAction(store, "Open story", async () => {
      setStoryIfCurrentRoute(store, id, { kind: "loading", id });
      const api = requireApi(store);
      try {
        const payload = await api.loadStory(id);
        setStoryIfCurrentRoute(store, id, { kind: "loaded", payload });
      } catch (error) {
        // A deleted (or never-existing) story renders its own "missing"
        // state instead of a toast — see `story/StoryPlaceholder.tsx` — so
        // this returns instead of rethrowing into `runAction`'s toast.
        if (apiErrorCode(error) === "not_found") {
          setStoryIfCurrentRoute(store, id, { kind: "missing", id });
          return;
        }
        throw error;
      }
    })),

    titleChanged: (updated) => {
      store.set((state) => (
        state.story.kind === "loaded" && state.story.payload.id === updated.id
          ? { ...state, story: { kind: "loaded", payload: updated } }
          : state
      ));
    }
  };
}
