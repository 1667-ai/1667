import { unsavedWork } from "./unsaved-work.js";
import type { ThemeMode } from "../theme/themes.js";
import { createAppActions, type AppActions } from "./actions.js";
import { connect, reconnect } from "./connection.js";
import { currentRoute, listenForRouteChanges } from "./router.js";
import { initialAppState, type AppState } from "./state.js";
import { createStore, type Store } from "./store.js";

export interface App {
  readonly store: Store<AppState>;
  readonly actions: AppActions;
  /**
   * Starts the connection, the route listener, and the visibility listener,
   * and returns one disposer that undoes all three — including closing
   * whichever connection attempt is current, even one still in flight
   * (review fix A1). Call once (module scope in `main.tsx`, or
   * `useState(() => createApp(...))`) and run `start()` from one effect
   * whose cleanup calls the disposer: under `<StrictMode>` (dev), React
   * runs that effect's setup, cleanup, and setup again, and this must never
   * leave a second bridge WebSocket open under the first one's back — the
   * server caps live sockets at 8.
   */
  start(): () => void;
}

/**
 * Builds the store and every action module, but starts nothing yet — `App`
 * built the store, actions, and connection all inline in a `useMemo` with
 * lint disables and an effect with no cleanup (review fix A1); this
 * separates "build" from "start" so `main.tsx` can build once, outside
 * React, and `App.tsx` becomes only the Provider and the Shell layout.
 */
export function createApp(initialTheme: ThemeMode | null, initialPalette: string): App {
  const store = createStore(initialAppState(currentRoute(), initialTheme, initialPalette));

  // The connection lifecycle lives here, not in `app/actions.ts`: `reconnect`
  // has to replace whichever attempt is currently in flight (or already
  // connected) with a new one, and only this closure ever holds that
  // disposer. `onConnected`/`doReconnect` close over `actions`, assigned
  // below — safe because neither runs until after `start()` (or a
  // Reconnect click, only possible once already started) calls them.
  let disposeConnection = (): void => {};
  const onConnected = (): void => {
    void actions.library.refresh();
  };
  const doReconnect = (): void => {
    disposeConnection();
    disposeConnection = reconnect(store, onConnected);
  };

  const actions = createAppActions(store, { reconnect: doReconnect });

  return {
    store,
    actions,
    start: () => {
      disposeConnection = connect(store, onConnected);
      const stopRouting = listenForRouteChanges((route) => {
        store.set((state) => ({ ...state, route }));
      });
      const onVisible = (): void => {
        if (document.visibilityState !== "visible") return;
        if (store.get().connection.kind !== "connected") return;
        void actions.library.refresh();
      };
      document.addEventListener("visibilitychange", onVisible);
      // A focus change debounces its durable-position write (~400ms); force
      // it out immediately whenever the tab might not get a later chance —
      // going to the background (`visibilitychange` hidden) and finally
      // going away (`pagehide`) both need this, not just one, because
      // platforms differ on which of the two actually fires before a tab is
      // discarded.
      const onHidden = (): void => {
        if (document.visibilityState === "hidden") actions.story.flushReadingPosition();
      };
      const onPageHide = (): void => actions.story.flushReadingPosition();
      document.addEventListener("visibilitychange", onHidden);
      addEventListener("pagehide", onPageHide);
      // A reload or a tab close mid-generation does not stop the write on
      // the server (decision: it keeps writing in the background), but it
      // does throw away this tab's only view of it — the live text, and any
      // "unsaved" leftover a failed save is holding for Copy/Discard. Warn
      // while something is in flight, being committed, or sitting unsaved —
      // review fix #1 (P1): `"unsaved"` used to be excluded on the theory
      // that the text "already survived one failure", but that text exists
      // nowhere else; reloading past this dialog without saving or copying
      // it first would lose the writer's only copy for good.
      const onBeforeUnload = (event: BeforeUnloadEvent): void => {
        const { generation, editor, compose, facts, settings, aside } = store.get();
        // A changed editor, changed settings and unsent composer text exist only in this page.
        if (generation.kind === "idle" && unsavedWork(editor, compose, facts, settings, aside).length === 0) return;
        event.preventDefault();
        event.returnValue = "";
      };
      addEventListener("beforeunload", onBeforeUnload);
      return () => {
        disposeConnection();
        stopRouting();
        document.removeEventListener("visibilitychange", onVisible);
        document.removeEventListener("visibilitychange", onHidden);
        removeEventListener("pagehide", onPageHide);
        removeEventListener("beforeunload", onBeforeUnload);
      };
    }
  };
}
