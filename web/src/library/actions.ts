import { apiErrorCode } from "../../../client/api-error.js";
import type { StoryApi } from "../../../client/api.js";
import type { StoryPayload } from "../../../shared/types.js";
import { navigate } from "../app/router.js";
import type { AppState } from "../app/state.js";
import type { Store } from "../app/store.js";
import { catchAtBoundary, errorMessage, pushToast, runAction } from "../app/toasts.js";
import type { DialogState } from "./state.js";

export interface LibraryActionDependencies {
  /** Notifies the story slice after a rename, instead of the Library writing
   * `state.story` itself (review fix B3). */
  readonly titleChanged: (updated: StoryPayload) => void;
}

export interface LibraryActions {
  refresh(): Promise<void>;
  setQuery(query: string): void;
  create(): Promise<void>;
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

function setDialog(store: Store<AppState>, dialog: DialogState): void {
  store.set((state) => ({ ...state, library: { ...state.library, dialog } }));
}

/**
 * `web/src/app/store.ts`'s pattern applied to the Library: one module of
 * plain functions closing over `store`, no class, no React. `listStories()`
 * runs on connect, after each mutation here, and on `visibilitychange` (see
 * `app/bootstrap.ts`), never inline in a component.
 *
 * Every function here is the public, never-rejecting boundary
 * (`catchAtBoundary`) around an internal `runAction` call that still throws —
 * a UI caller's `void actions.library.x()` never produces an unhandled
 * rejection (review fix B7), including when `requireApi` throws because the
 * bridge is not connected.
 */
export function createLibraryActions(
  store: Store<AppState>,
  deps: LibraryActionDependencies
): LibraryActions {
  // Refresh race (Codex review): `listStories()` runs on connect, on
  // visibilitychange, and after every mutation below, so calls overlap —
  // and their responses can resolve out of order. `refreshSequence` tags
  // each call with the order it was ISSUED in (not resolved in), so a
  // response is only applied if no later call has since started; comparing
  // the captured `connection` object by reference also drops a response
  // that arrives after a reconnect has replaced it, even if (in some future
  // change) that reconnect did not itself trigger a newer refresh. Without
  // both checks, a slow response from a refresh issued before a delete or
  // rename could land after that mutation's own (faster) refresh and
  // resurrect a deleted row or an old title.
  let refreshSequence = 0;

  const refreshUnwrapped = async (): Promise<void> => {
    const connection = store.get().connection;
    if (connection.kind !== "connected") throw new Error("1667 web: not connected");
    const ticket = ++refreshSequence;
    const stories = await connection.api.listStories();
    if (ticket !== refreshSequence) return; // a newer refresh has already started
    if (store.get().connection !== connection) return; // the connection has since changed
    store.set((state) => ({ ...state, library: { ...state.library, stories } }));
  };

  return {
    refresh: () => catchAtBoundary(() => runAction(store, "Load library", refreshUnwrapped)),

    setQuery: (query) => {
      store.set((state) => ({ ...state, library: { ...state.library, query } }));
    },

    create: () => catchAtBoundary(() => runAction(store, "New story", async () => {
      const api = requireApi(store);
      const created = await api.createStory();
      await refreshUnwrapped();
      navigate({ kind: "story", id: created.id });
    })),

    startRename: (id, title) => setDialog(store, { kind: "rename", storyId: id, title }),
    startDelete: (id, title) => setDialog(store, { kind: "delete", storyId: id, title }),
    cancelDialog: () => setDialog(store, { kind: "none" }),

    // The throwing inner call keeps the dialog open on failure: `setDialog`
    // to "none" only runs after `api.renameStory` succeeds, so an error
    // thrown from it (and reported by `runAction`) skips straight past that
    // line and the rename dialog stays up for another try.
    confirmRename: (title) => catchAtBoundary(() => runAction(store, "Rename story", async () => {
      const dialog = store.get().library.dialog;
      if (dialog.kind !== "rename") return;
      const trimmed = title.trim();
      if (trimmed.length === 0) return;
      const api = requireApi(store);
      const updated = await api.renameStory(dialog.storyId, trimmed);
      setDialog(store, { kind: "none" });
      deps.titleChanged(updated);
      await refreshUnwrapped();
    })),

    // Review fix B4: `storyId` and the "was this the open story" check both
    // read the CURRENT route after `deleteStory` resolves, not before — a
    // route captured before the `await` could name a story the owner has
    // since navigated away from (or back to), and navigating "home" on its
    // account would then be wrong.
    confirmDelete: () => catchAtBoundary(() => runAction(store, "Delete story", async () => {
      const dialog = store.get().library.dialog;
      if (dialog.kind !== "delete") return;
      const storyId = dialog.storyId;
      const api = requireApi(store);
      setDialog(store, { kind: "none" });
      try {
        await api.deleteStory(storyId);
      } catch (error) {
        if (apiErrorCode(error) !== "not_found") {
          await refreshUnwrapped();
          throw error;
        }
        pushToast(store, errorMessage(error, { not_found: "That story is already gone." }));
      }
      const route = store.get().route;
      if (route.kind === "story" && route.id === storyId) navigate({ kind: "library" });
      await refreshUnwrapped();
    }))
  };
}
