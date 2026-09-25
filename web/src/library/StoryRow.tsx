import { formatAge } from "../../../shared/story-model.js";
import type { StorySummary } from "../../../shared/types.js";
import { Icon, ICONS } from "../ui/icons.js";
import { usePopover } from "../ui/usePopover.js";

/** Moved out of `library/Sidebar.tsx` (review fix B6): one story row, plus
 * its "⋯" menu. */
export function StoryRow(
  { summary, active, onOpen, onRename, onDelete }: {
    readonly summary: StorySummary;
    readonly active: boolean;
    readonly onOpen: () => void;
    readonly onRename: () => void;
    readonly onDelete: () => void;
  }
) {
  return (
    <div className={`story-item${active ? " active" : ""}`}>
      <button type="button" className="story-item-main" onClick={onOpen}>
        <span className="story-item-title">{summary.title}</span>
        <span className="story-item-meta">
          <span>
            {summary.partCount} {summary.partCount === 1 ? "part" : "parts"} ·{" "}
            {summary.words.toLocaleString()} words
          </span>
          {summary.lineCount > 1 && (
            <span className="story-line-count" title={`${summary.lineCount} lines`}>
              ⑂ {summary.lineCount}
            </span>
          )}
          <span className="mono-meta">{formatAge(summary.updatedAt).toLowerCase()}</span>
        </span>
      </button>
      <RowMenu onRename={onRename} onDelete={onDelete} title={summary.title} />
    </div>
  );
}

function RowMenu(
  { onRename, onDelete, title }: {
    readonly onRename: () => void;
    readonly onDelete: () => void;
    readonly title: string;
  }
) {
  const { open, setOpen, containerRef } = usePopover();

  return (
    <div className="story-item-menu" ref={containerRef}>
      <button
        type="button"
        className="icon-btn story-item-menu-trigger"
        title={`More for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon path={ICONS.dots} />
      </button>
      {open && (
        <div className="story-item-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            className="story-item-menu-item"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            <Icon path={ICONS.pen} />
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="story-item-menu-item story-item-menu-danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Icon path={ICONS.trash} />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
