import { useEffect, useMemo, useRef, useState } from "react";
import { AppProvider, useAppContext } from "./app/context.js";
import { reconnect, startConnection } from "./app/connection.js";
import { currentRoute, listenForRouteChanges } from "./app/router.js";
import { initialAppState } from "./app/state.js";
import { createStore, useStore } from "./app/store.js";
import { dismissToast } from "./app/toasts.js";
import { applyPalette, applyTheme, persistPalette, persistTheme } from "./theme/apply.js";
import { createLibraryActions } from "./library/actions.js";
import {
  ClosedOverlay,
  ConnectingScreen,
  FailedScreen,
  LockedScreen
} from "./ui/ConnectionScreens.js";
import { RecoveryBanner } from "./ui/RecoveryBanner.js";
import { ToastStack } from "./ui/Toasts.js";
import { Icon, ICONS } from "./ui/icons.js";
import { Sidebar } from "./library/Sidebar.js";
import { StoryPlaceholder } from "./story/StoryPlaceholder.js";
import type { ThemeMode } from "./theme/themes.js";

export function App({
  initialTheme,
  initialPalette
}: {
  readonly initialTheme: ThemeMode | null;
  readonly initialPalette: string;
}) {
  const contextValue = useMemo(() => {
    const store = createStore(initialAppState(currentRoute(), initialTheme, initialPalette));
    const library = createLibraryActions(store);
    return {
      store,
      actions: {
        library,
        reconnect: () => reconnect(store),
        toggleTheme: () => {
          const current = store.get().theme;
          const next = current === "dark" ? "light" : current === "light" ? "dark" : oppositeOfSystem();
          applyTheme(next);
          persistTheme(next);
          store.set((state) => ({ ...state, theme: next }));
        },
        selectPalette: (paletteId: string) => {
          applyPalette(paletteId);
          persistPalette(paletteId);
          store.set((state) => ({ ...state, palette: paletteId }));
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    startConnection(contextValue.store);
    const stopRouting = listenForRouteChanges((route) => {
      contextValue.store.set((state) => ({ ...state, route }));
    });
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      if (contextValue.store.get().connection.kind !== "connected") return;
      void contextValue.actions.library.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopRouting();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AppProvider value={contextValue}>
      <Shell />
    </AppProvider>
  );
}

/** The OS preference `theme === null` was already following, so the first
 * explicit press flips away from whichever face is on screen right now. */
function oppositeOfSystem(): "light" | "dark" {
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "light" : "dark";
}

function Shell() {
  const { store, actions } = useAppContext();
  const connection = useStore(store, (state) => state.connection);
  const route = useStore(store, (state) => state.route);
  const toasts = useStore(store, (state) => state.toasts);
  const recoveryWarnings = useStore(store, (state) => state.recoveryWarnings);
  const hasConnectedOnce = useRef(false);
  // Below ~800px (owner decision) the sidebar is a drawer instead of a
  // persistent column; `.sidebar-toggle-open`/`Sidebar`'s own drawer classes
  // only take effect there (see `styles/sidebar.css`), so this state does
  // nothing at desktop width.
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    if (connection.kind === "connected" && !hasConnectedOnce.current) {
      hasConnectedOnce.current = true;
      void actions.library.refresh();
    }
  }, [connection, actions]);

  if (connection.kind === "connecting") return <ConnectingScreen />;
  if (connection.kind === "locked") return <LockedScreen />;
  if (connection.kind === "failed") return <FailedScreen message={connection.message} />;

  // "closed" overlays the frozen UI rather than replacing it, so the owner
  // still sees the last-known state while deciding whether to reconnect.
  const closed = connection.kind === "closed" ? connection.message : null;

  return (
    <div className="app">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="main">
        <button
          type="button"
          className="icon-btn sidebar-toggle"
          aria-label="Open menu"
          onClick={() => setSidebarOpen(true)}
        >
          <Icon path={ICONS.menu} />
        </button>
        {recoveryWarnings.length > 0 && (
          <RecoveryBanner
            warnings={recoveryWarnings}
            onDismiss={(mutationId) => {
              if (connection.kind === "connected") {
                void connection.transport.dismissArchivedMutation(mutationId);
              }
            }}
          />
        )}
        {route.kind === "story"
          ? <StoryPlaceholder storyId={route.id} />
          : <LibraryHome />}
      </main>
      <ToastStack toasts={toasts} onDismiss={(id) => dismissToast(store, id)} />
      {closed !== null && <ClosedOverlay message={closed} onReconnect={actions.reconnect} />}
    </div>
  );
}

function LibraryHome() {
  const { store } = useAppContext();
  const stories = useStore(store, (state) => state.library.stories);
  if (stories === null) {
    return <p className="story-empty">Loading your library…</p>;
  }
  if (stories.length === 0) {
    return (
      <div className="welcome">
        <h1>No stories yet</h1>
        <p>Create one to start writing.</p>
      </div>
    );
  }
  const words = stories.reduce((total, story) => total + story.words, 0);
  return (
    <div className="welcome">
      <h1>1667</h1>
      <p>
        {stories.length} {stories.length === 1 ? "story" : "stories"} ·{" "}
        {words.toLocaleString()} words
      </p>
    </div>
  );
}
