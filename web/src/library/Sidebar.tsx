import { useEffect, useRef, useState } from "react";
import type { StorySummary } from "../../../shared/types.js";
import { formatAge } from "../../../shared/story-model.js";
import { useAppContext } from "../app/context.js";
import { navigate } from "../app/router.js";
import { useStore } from "../app/store.js";
import { PALETTES, type ThemeMode } from "../theme/themes.js";
import { Icon, ICONS } from "../ui/icons.js";
import { DeleteDialog } from "./DeleteDialog.js";
import { RenameDialog } from "./RenameDialog.js";

/** Structural start ported from `~/source/storytavern/web/src/Sidebar.tsx`
 * (brand bar, theme toggle, palette popover, story list), adapted to this
 * app's store/actions and to `StorySummary`'s own fields. `.sidebar-settings`
 * is dropped — there is no settings screen yet.
 *
 * Below ~800px (owner decision) this becomes a drawer: `open` and `onClose`
 * are undefined at desktop width (the persistent sidebar), and provided by
 * `App.tsx`'s `Shell` once the CSS breakpoint applies. */
export function Sidebar(
  { open, onClose }: { readonly open?: boolean; readonly onClose?: () => void } = {}
) {
  const { store, actions } = useAppContext();
  const theme = useStore(store, (state) => state.theme);
  const palette = useStore(store, (state) => state.palette);
  const route = useStore(store, (state) => state.route);
  const stories = useStore(store, (state) => state.library.stories);
  const query = useStore(store, (state) => state.library.query);
  const dialog = useStore(store, (state) => state.dialog);
  const projectLabel = useStore(store, (state) => (
    state.connection.kind === "connected" ? state.connection.status.project : null
  ));

  const activeId = route.kind === "story" ? route.id : null;
  const visible = filterAndSort(stories, query);
  const closeDrawer = (): void => onClose?.();

  return (
    <>
      {open === true && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close menu"
          onClick={closeDrawer}
        />
      )}
      <aside className={`sidebar${open === true ? " open" : ""}`}>
        <div className="brand">
          <div className="brand-identity">
            <span className="brand-name">1667</span>
            {projectLabel !== null && (
              <span className="mono-meta brand-project" title={projectLabel}>{projectLabel}</span>
            )}
          </div>
          <div className="brand-actions">
            <ThemeControls
              theme={theme}
              palette={palette}
              onToggleTheme={actions.toggleTheme}
              onSelectPalette={actions.selectPalette}
            />
            {onClose !== undefined && (
              <button
                type="button"
                className="icon-btn sidebar-close"
                aria-label="Close menu"
                onClick={closeDrawer}
              >
                <Icon path={ICONS.x} />
              </button>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => {
            closeDrawer();
            void actions.library.create();
          }}
        >
          <Icon path={ICONS.plus} />
          New story
        </button>

        <div className="field sidebar-search">
          <input
            type="search"
            placeholder="Search stories"
            aria-label="Search stories"
            value={query}
            onChange={(event) => actions.library.setQuery(event.currentTarget.value)}
          />
        </div>

        <nav className="story-list">
          {stories === null && <p className="story-list-empty">Loading…</p>}
          {stories !== null && stories.length === 0 && (
            <p className="story-list-empty">No stories yet — create one.</p>
          )}
          {stories !== null && stories.length > 0 && visible.length === 0 && (
            <p className="story-list-empty">No stories match.</p>
          )}
          {visible.map((summary) => (
            <StoryRow
              key={summary.id}
              summary={summary}
              active={summary.id === activeId}
              onOpen={() => {
                closeDrawer();
                navigate({ kind: "story", id: summary.id });
              }}
              onRename={() => actions.library.startRename(summary.id, summary.title)}
              onDelete={() => actions.library.startDelete(summary.id, summary.title)}
            />
          ))}
        </nav>

        {dialog.kind === "rename" && (
          <RenameDialog
            title={dialog.title}
            onCancel={actions.library.cancelDialog}
            onSave={(title) => void actions.library.confirmRename(title)}
          />
        )}
        {dialog.kind === "delete" && (
          <DeleteDialog
            title={dialog.title}
            onCancel={actions.library.cancelDialog}
            onDelete={() => void actions.library.confirmDelete()}
          />
        )}
      </aside>
    </>
  );
}

function filterAndSort(
  stories: readonly StorySummary[] | null,
  query: string
): readonly StorySummary[] {
  if (stories === null) return [];
  const needle = query.trim().toLowerCase();
  const matching = needle.length === 0
    ? stories
    : stories.filter((summary) => summary.title.toLowerCase().includes(needle));
  return [...matching].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function StoryRow(
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPress = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="story-item-menu" ref={ref}>
      <button
        type="button"
        className="icon-btn story-item-menu-trigger"
        title={`More for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
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

function ThemeControls(
  { theme, palette, onToggleTheme, onSelectPalette }: {
    readonly theme: ThemeMode | null;
    readonly palette: string;
    readonly onToggleTheme: () => void;
    readonly onSelectPalette: (paletteId: string) => void;
  }
) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const isDark = theme === "dark"
    || (theme === null && matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <>
      <button
        className="theme-toggle theme-pick"
        type="button"
        title="Choose theme"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((open) => !open)}
      >
        <Icon path={ICONS.droplet} />
      </button>
      <button
        className="theme-toggle"
        type="button"
        title="Toggle light / dark"
        onClick={onToggleTheme}
      >
        <Icon path={isDark ? ICONS.sun : ICONS.moon} />
      </button>
      {pickerOpen && (
        <ThemePicker
          isDark={isDark}
          palette={palette}
          onSelectPalette={onSelectPalette}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

function ThemePicker(
  { isDark, palette, onSelectPalette, onClose }: {
    readonly isDark: boolean;
    readonly palette: string;
    readonly onSelectPalette: (paletteId: string) => void;
    readonly onClose: () => void;
  }
) {
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPress = (event: MouseEvent): void => {
      const container = popoverRef.current?.parentElement ?? popoverRef.current;
      if (container !== null && container !== undefined && !container.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const mode: ThemeMode = isDark ? "dark" : "light";
  return (
    <div ref={popoverRef} className="theme-popover" role="menu" aria-label="Theme">
      <div className="theme-popover-label">Palette</div>
      {PALETTES.map((candidate) => {
        const dots = candidate.dots[mode];
        return (
          <button
            key={candidate.id}
            type="button"
            role="menuitemradio"
            aria-checked={candidate.id === palette}
            className={`theme-row${candidate.id === palette ? " active" : ""}`}
            onClick={() => {
              onSelectPalette(candidate.id);
              onClose();
            }}
          >
            <span className="theme-dots">
              <span className="theme-dot" style={{ background: dots.bg, borderColor: dots.line }} />
              <span className="theme-dot theme-dot-overlap" style={{ background: dots.accent }} />
              <span className="theme-dot theme-dot-overlap" style={{ background: dots.ink }} />
            </span>
            <span className="theme-row-text">
              <span className="theme-row-name">{candidate.name}</span>
              <span className="theme-row-tagline">{candidate.tagline}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
