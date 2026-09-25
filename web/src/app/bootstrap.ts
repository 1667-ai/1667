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
      return () => {
        disposeConnection();
        stopRouting();
        document.removeEventListener("visibilitychange", onVisible);
      };
    }
  };
}
