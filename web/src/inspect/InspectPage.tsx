import { useCallback, useEffect, type ReactNode } from "react";
import { useAppContext } from "../app/context.js";
import { closeStoryPage, type StoryPage } from "../app/router.js";
import { useStore } from "../app/store.js";
import { GenerationBar } from "../generation/GenerationBar.js";
import { storyIdOf } from "../story/state.js";
import { Icon, ICONS } from "../ui/icons.js";
import { SidebarToggle } from "../ui/SidebarToggle.js";
import { ProbsViewer } from "./ProbsViewer.js";
import { RecordViewer } from "./RecordViewer.js";
import { RequestViewer } from "./RequestViewer.js";

/** The page's chrome: the same header as the map, a body that scrolls, and
 * the stop bar underneath so a running generation stays stoppable. */
export function InspectChrome(
  { storyTitle, title, detail, onOpenSidebar, onClose, children }: {
    readonly storyTitle: string;
    readonly title: string;
    readonly detail: string;
    readonly onOpenSidebar: () => void;
    readonly onClose: () => void;
    readonly children: ReactNode;
  }
) {
  return (
    <div className="story-view story-inspect" data-inspect-root="true" tabIndex={-1}>
      <header className="story-header map-header">
        <SidebarToggle onOpen={onOpenSidebar} />
        <div className="story-identity">
          <span className="story-kicker map-kicker">{storyTitle}</span>
          <div className="story-title-wrap"><h1 className="story-title">{title}</h1></div>
          <span className="story-stats map-stats">{detail}</span>
        </div>
        <div className="story-actions map-actions">
          <button type="button" className="icon-btn" title={`Close ${title.toLowerCase()} (Esc)`} aria-label={`Close ${title.toLowerCase()} (Esc)`} onClick={onClose}>
            <Icon path={ICONS.x} />
          </button>
        </div>
      </header>
      <div className="inspect-body">{children}</div>
      <GenerationBar />
    </div>
  );
}

/**
 * `#/story/<id>/request`, `/records/<node>` and `/probs/<node>`: the three
 * inspectors as pages of their own, like the map. Back or Esc closes one and
 * the story page opens with its focus where it was.
 */
export function InspectPage(
  { storyId, page, onOpenSidebar }: { readonly storyId: string; readonly page: StoryPage; readonly onOpenSidebar: () => void }
) {
  const { store, actions } = useAppContext();
  const story = useStore(store, (state) => (storyIdOf(state.story) === storyId ? state.story : null));
  useEffect(() => {
    void actions.story.load(storyId);
  }, [storyId, actions]);
  const onClose = useCallback(() => closeStoryPage(storyId), [storyId]);

  if (story === null || story.kind === "idle" || story.kind === "loading") {
    return (
      <>
        <div className="main-toolbar"><SidebarToggle onOpen={onOpenSidebar} /></div>
        <p className="story-empty">Loading…</p>
      </>
    );
  }
  if (story.kind === "missing") {
    return (
      <>
        <div className="main-toolbar"><SidebarToggle onOpen={onOpenSidebar} /></div>
        <div className="welcome">
          <h1>This story no longer exists</h1>
          <p>It may have been deleted in another tab, or its link was old.</p>
          <a className="btn btn-primary" href="#/">Back to the Library</a>
        </div>
      </>
    );
  }
  const common = { storyId, payload: story.payload, onOpenSidebar, onClose };
  switch (page.kind) {
    case "request": return <RequestViewer {...common} />;
    case "records": return <RecordViewer {...common} nodeId={page.nodeId} />;
    case "probs": return <ProbsViewer {...common} nodeId={page.nodeId} />;
  }
}
