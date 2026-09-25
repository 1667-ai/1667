import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import { navigate } from "../app/router.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { errorMessage, pushToast, runAction } from "../app/toasts.js";

export interface LibraryActions {
  refresh(): Promise<void>;
  setQuery(query: string): void;
  create(): Promise<void>;
  openStory(id: string): Promise<void>;
  startRename(id: string, title: string): void;
  startDelete(id: string, title: string): void;
  cancelDialog(): void;
  confirmRename(title: string): Promise<void>;
  confirmDelete(): Promise<void>;
}

function requireApi(store: Store<AppState>): StoryApi {
  const connection = store.get().connection;
  if (connection.kind !== "connected") throw new Error("1667 web: not connected");
  return connection.api;
}

/**
 * `web/src/app/store.ts`'s pattern applied to the Library: one module of
 * plain functions closing over `store`, no class, no React. `listStories()`
 * runs on connect, after each mutation here, and on `visibilitychange` (see
 * `App.tsx`), never inline in a component.
 */
export function createLibraryActions(store: Store<AppState>): LibraryActions {
  const refreshUnwrapped = async (): Promise<void> => {
    const api = requireApi(store);
    const stories = await api.listStories();
    store.set((state) => ({ ...state, library: { ...state.library, stories } }));
  };
  const refresh = (): Promise<void> => runAction(store, "Load library", refreshUnwrapped);

  return {
    refresh,

    setQuery: (query) => {
      store.set((state) => ({ ...state, library: { ...state.library, query } }));
    },

    create: async () => {
      const api = requireApi(store);
      const created = await runAction(store, "New story", () => api.createStory());
      await refreshUnwrapped();
      navigate({ kind: "story", id: created.id });
    },

    openStory: async (id) => {
      const api = requireApi(store);
      const payload = await runAction(store, "Open story", () => api.loadStory(id));
      // Stale responses: adopt the payload only if the route still names
      // this id — a fast second click on another row must not have its
      // first (slower) response land after the user has already moved on.
      store.set((state) => (
        state.route.kind === "story" && state.route.id === id
          ? { ...state, openStory: payload }
          : state
      ));
    },

    startRename: (id, title) => {
      store.set((state) => ({ ...state, dialog: { kind: "rename", storyId: id, title } }));
    },

    startDelete: (id, title) => {
      store.set((state) => ({ ...state, dialog: { kind: "delete", storyId: id, title } }));
    },

    cancelDialog: () => {
      store.set((state) => ({ ...state, dialog: { kind: "none" } }));
    },

    confirmRename: async (title) => {
      const dialog = store.get().dialog;
      if (dialog.kind !== "rename") return;
      const trimmed = title.trim();
      if (trimmed.length === 0) return;
      const api = requireApi(store);
      const updated = await runAction(
        store,
        "Rename story",
        () => api.renameStory(dialog.storyId, trimmed)
      );
      store.set((state) => ({
        ...state,
        dialog: { kind: "none" },
        openStory: state.openStory !== null && state.openStory.id === updated.id
          ? updated
          : state.openStory
      }));
      await refreshUnwrapped();
    },

    confirmDelete: async () => {
      const dialog = store.get().dialog;
      if (dialog.kind !== "delete") return;
      const api = requireApi(store);
      store.set((state) => ({ ...state, dialog: { kind: "none" } }));
      const route = store.get().route;
      const wasOpenStory = route.kind === "story" && route.id === dialog.storyId;
      try {
        await api.deleteStory(dialog.storyId);
      } catch (error) {
        if (apiErrorCode(error) === "not_found") {
          pushToast(store, "That story is already gone.");
        } else {
          pushToast(store, `Delete story failed: ${errorMessage(error)}`);
          await refreshUnwrapped();
          return;
        }
      }
      if (wasOpenStory) navigate({ kind: "library" });
      await refreshUnwrapped();
    }
  };
}
