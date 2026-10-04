import { useEffect, useState } from "react";
import type { App as WebApp } from "./app/bootstrap.js";
import { AppProvider, useAppContext } from "./app/context.js";
import { useStore } from "./app/store.js";
import { dismissToast } from "./app/toasts.js";
import { UnsavedWork, useHasUnsavedWork } from "./ui/UnsavedWork.js";
import { GenerationBar } from "./generation/GenerationBar.js";
import { NoteDialog } from "./notes/NoteDialog.js";
import { Overlays } from "./palette/Overlays.js";
import { LibraryDialogs } from "./library/LibraryDialogs.js";
import { LibraryHome } from "./library/LibraryHome.js";
import { Sidebar } from "./library/Sidebar.js";
import { InspectPage } from "./inspect/InspectPage.js";
import { StoryMap } from "./map/StoryMap.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { StoryView } from "./story/StoryView.js";
import {
  ClosedOverlay,
  ConnectingScreen,
  FailedScreen,
  LockedScreen
} from "./ui/ConnectionScreens.js";
import { RecoveryBanner } from "./ui/RecoveryBanner.js";
import { ToastStack } from "./ui/Toasts.js";
import { SidebarToggle } from "./ui/SidebarToggle.js";
import { useBarClearance } from "./ui/bar-clearance.js";

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
  const unsaved = useStore(store, (state) => state.generation.kind === "unsaved");
  // Below ~800px (owner decision) the sidebar is a drawer instead of a
  // persistent column; `Sidebar`'s own drawer classes (see
  // `styles/sidebar.css`) only take effect there, so this state does
  // nothing at desktop width.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const openSidebar = (): void => setSidebarOpen(true);
  // Esc-stops-a-background-generation (owner decision 2: "from anywhere")
  // now lives in `app/keymap.ts`'s `useKeymap` (`Sidebar.tsx`, always
  // mounted) as a sibling of its own Escape/`/` handling — review fix #3.
  // It used to be this file's own always-mounted `useGenerationEscape`
  // listener, independent of `registerScreenKeys`'s per-screen dispatch;
  // folding it into the same listener is what lets a popover's own Escape
  // (`ui/usePopover.ts`, now calling `preventDefault`) take priority over it.

  // Unsaved generation text lives only in memory. The connection screens
  // below replace the whole UI, so they must keep its Copy/Retry/Discard bar,
  // or a failed reconnect would leave the text unreachable.
  const hasUnsavedWork = useHasUnsavedWork();
  const recoveryRef = useBarClearance();
  const recovery = unsaved || hasUnsavedWork
    ? (
      <div ref={recoveryRef} className="connection-recovery">
        {unsaved && <GenerationBar />}
        <UnsavedWork />
      </div>
    )
    : null;
  if (connection.kind === "connecting") return <><ConnectingScreen />{recovery}</>;
  if (connection.kind === "locked") return <><LockedScreen />{recovery}</>;
  if (connection.kind === "failed") return <><FailedScreen message={connection.message} />{recovery}</>;

  // "closed" overlays the frozen UI rather than replacing it, so the owner
  // still sees the last-known state while deciding whether to reconnect.
  const closed = connection.kind === "closed" ? connection.message : null;

  return (
    <div className="app">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="main">
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
        {route.kind === "settings"
          ? <SettingsPage onOpenSidebar={openSidebar} />
          : route.kind === "story"
          ? (route.page !== undefined
            ? <InspectPage storyId={route.id} page={route.page} onOpenSidebar={openSidebar} />
            : route.map === true
              ? <StoryMap storyId={route.id} onOpenSidebar={openSidebar} />
              : <StoryView storyId={route.id} onOpenSidebar={openSidebar} />)
          : (
            <>
              <div className="main-toolbar"><SidebarToggle onOpen={openSidebar} /></div>
              <LibraryHome />
              {/* Only ever shows a bar here while a generation is running
               * somewhere in the background (owner decision 2) — `GenerationBar`
               * itself renders nothing on this route while idle. */}
              <GenerationBar />
            </>
          )}
      </main>
      <LibraryDialogs />
      <NoteDialog />
      <Overlays openLibrary={openSidebar} />
      <ToastStack toasts={toasts} onDismiss={(id) => dismissToast(store, id)} />
      {closed !== null && <ClosedOverlay message={closed} onReconnect={actions.reconnect} />}
      {closed !== null && hasUnsavedWork && <div ref={recoveryRef} className="connection-recovery"><UnsavedWork /></div>}
    </div>
  );
}
