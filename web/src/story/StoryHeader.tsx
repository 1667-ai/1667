import { countWords } from "../../../shared/story-text.js";
import type { StoryPayload } from "../../../shared/types.js";
import { useAppContext } from "../app/context.js";
import { useStore } from "../app/store.js";
import { Icon, ICONS } from "../ui/icons.js";
import { LineChip } from "../tags/LineChip.js";
import { SidebarToggle } from "../ui/SidebarToggle.js";

export interface StoryHeaderProps {
  readonly payload: StoryPayload;
  readonly showDirections: boolean;
  readonly onToggleDirections: () => void;
  /** Opens the Library drawer (only shown below the drawer breakpoint). */
  readonly onOpenSidebar: () => void;
}

/** Title, stats, and the "Show directions" toggle. Ported from
 * `~/source/storytavern/web/src/story.css`'s header rules
 * (`web/src/styles/story.css` already carries them, from step 3's
 * placeholder) — the title is a plain heading here, never an editable
 * field (that is write-side, later steps). */
export function StoryHeader({ payload, showDirections, onToggleDirections, onOpenSidebar }: StoryHeaderProps) {
  const { store, actions } = useAppContext();
  const panelView = useStore(store, (state) => state.panel.view);
  const words = payload.path.reduce((total, node) => total + countWords(node.text), 0);

  return (
    <header className="story-header">
      <SidebarToggle onOpen={onOpenSidebar} />
      <div className="story-identity">
        <LineChip payload={payload} />
        <div className="story-title-wrap">
          <h1 className="story-title" title={payload.title}>{payload.title}</h1>
        </div>
        <span className="story-stats">
          {payload.path.length} {payload.path.length === 1 ? "part" : "parts"} ·{" "}
          {words.toLocaleString()} words
        </span>
      </div>
      <div className="story-actions">
        {(["chapters", "facts"] as const).map((view) => (
          <button
            key={view}
            type="button"
            className="icon-btn"
            aria-pressed={panelView === view}
            title={view === "chapters" ? "Chapters (c)" : "Facts (f)"}
            aria-label={view === "chapters" ? "Chapters (c)" : "Facts (f)"}
            onClick={() => (panelView === view ? actions.panel.close() : actions.panel.open(view))}
          >
            <Icon path={view === "chapters" ? ICONS.summary : ICONS.facts} />
          </button>
        ))}
        <button
          type="button"
          className="btn btn-ghost btn-small"
          aria-pressed={showDirections}
          title={showDirections ? "Hide directions (p)" : "Show directions (p)"}
          onClick={onToggleDirections}
        >
          Show directions
        </button>
      </div>
    </header>
  );
}
