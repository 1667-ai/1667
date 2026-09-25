import { useEffect, useState } from "react";
import type { App as WebApp } from "./app/bootstrap.js";
import { AppProvider, useAppContext } from "./app/context.js";
import { useStore } from "./app/store.js";
import { dismissToast } from "./app/toasts.js";
import { LibraryDialogs } from "./library/LibraryDialogs.js";
import { LibraryHome } from "./library/LibraryHome.js";
import { Sidebar } from "./library/Sidebar.js";
import { StoryPlaceholder } from "./story/StoryPlaceholder.js";
import {
  ClosedOverlay,
  ConnectingScreen,
  FailedScreen,
  LockedScreen
} from "./ui/ConnectionScreens.js";
import { RecoveryBanner } from "./ui/RecoveryBanner.js";
import { ToastStack } from "./ui/Toasts.js";
import { Icon, ICONS } from "./ui/icons.js";

/**
 * Review fix A1: the store, every action module, and the connection
 * lifecycle now all live in `app/bootstrap.ts` (`createApp`, built once by
 * `main.tsx`) instead of a `useMemo` here with lint disables. This file is
 * only the Provider and the Shell layout.
 */
export function App({ app }: { readonly app: WebApp }) {
  useEffect(() => app.start(), [app]);

  return (
    <AppProvider value={{ store: app.store, actions: app.actions }}>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const { store, actions } = useAppContext();
  const connection = useStore(store, (state) => state.connection);
  const route = useStore(store, (state) => state.route);
  const toasts = useStore(store, (state) => state.toasts);
  const recoveryWarnings = useStore(store, (state) => state.recoveryWarnings);
  // Below ~800px (owner decision) the sidebar is a drawer instead of a
  // persistent column; `Sidebar`'s own drawer classes (see
  // `styles/sidebar.css`) only take effect there, so this state does
  // nothing at desktop width.
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
      <LibraryDialogs />
      <ToastStack toasts={toasts} onDismiss={(id) => dismissToast(store, id)} />
      {closed !== null && <ClosedOverlay message={closed} onReconnect={actions.reconnect} />}
    </div>
  );
}
