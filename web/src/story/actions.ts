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
  // Codex review: `StoryPlaceholder`'s mount effect has no cleanup, so
  // `<StrictMode>` (dev) calls `load(id)` twice back to back for the same
  // id before either settles. Without de-duplication, both issued a real
  // `loadStory(id)` request; the second's own opportunistic residue-recovery
  // claim on that story's mutation scope could still be active when a
  // near-immediate delete of the SAME story tried to claim it for real,
  // which the server rejects as "busy" — not a genuine capacity limit, just
  // the app racing itself against one story. A second `load` for an id
  // already in flight reuses the first call's promise instead of issuing a
  // second request.
  const inFlight = new Map<string, Promise<void>>();

  const loadUnwrapped = (id: string): Promise<void> => catchAtBoundary(() => runAction(store, "Open story", async () => {
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
  }));

  return {
    load: (id) => {
      const existing = inFlight.get(id);
      if (existing !== undefined) return existing;
      const promise = loadUnwrapped(id).finally(() => {
        if (inFlight.get(id) === promise) inFlight.delete(id);
      });
      inFlight.set(id, promise);
      return promise;
    },

    titleChanged: (updated) => {
      store.set((state) => (
        state.story.kind === "loaded" && state.story.payload.id === updated.id
          ? { ...state, story: { kind: "loaded", payload: updated } }
          : state
      ));
    }
  };
}
