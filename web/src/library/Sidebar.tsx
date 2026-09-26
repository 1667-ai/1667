import { useRef } from "react";
import { useAppContext } from "../app/context.js";
import { useKeymap } from "../app/keymap.js";
import { navigate } from "../app/router.js";
import { useStore } from "../app/store.js";
import { ThemeControls } from "../theme/ThemeControls.js";
import { Icon, ICONS } from "../ui/icons.js";
import { filterAndSort } from "./filterStories.js";
import { StoryRow } from "./StoryRow.js";

/**
 * Structural start ported from `~/source/storytavern/web/src/Sidebar.tsx`
 * (brand bar, theme toggle, palette popover, story list), adapted to this
 * app's store/actions and to `StorySummary`'s own fields. `.sidebar-settings`
 * is dropped — there is no settings screen yet. This file is now just the
 * shell around `theme/ThemeControls.tsx`, `library/StoryRow.tsx`, and
 * `library/filterStories.ts` (review fix B6) — the Rename/Delete dialogs
 * moved to `library/LibraryDialogs.tsx`, which `App.tsx`'s `Shell` mounts
 * directly instead of nesting them here.
 *
 * Below ~800px (owner decision) this becomes a drawer: `App.tsx`'s `Shell`
 * always passes `open`/`onClose` (review fix D13); the CSS breakpoint
 * (`styles/sidebar.css`) is what makes them matter only there.
 */
export function Sidebar({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const { store, actions } = useAppContext();
  const theme = useStore(store, (state) => state.theme);
  const palette = useStore(store, (state) => state.palette);
  const route = useStore(store, (state) => state.route);
  const stories = useStore(store, (state) => state.library.stories);
  const query = useStore(store, (state) => state.library.query);
  const projectLabel = useStore(store, (state) => (
    state.connection.kind === "connected" ? state.connection.status.project : null
  ));

  const activeId = route.kind === "story" ? route.id : null;
  const visible = filterAndSort(stories, query);
  const searchRef = useRef<HTMLInputElement>(null);
  useKeymap({ searchRef });

  return (
    <>
      {open && (
        <button type="button" className="sidebar-backdrop" aria-label="Close menu" onClick={onClose} />
      )}
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="brand">
          <div className="brand-identity">
            <span className="brand-name">1667</span>
            {projectLabel !== null && (
              <span className="mono-meta brand-project" title={projectLabel}>
                {projectFolderName(projectLabel)}
              </span>
            )}
          </div>
          <div className="brand-actions">
            <ThemeControls
              theme={theme}
              palette={palette}
              onToggleTheme={actions.theme.toggleTheme}
              onSelectPalette={actions.theme.selectPalette}
            />
            <button
              type="button"
              className="icon-btn sidebar-close"
              aria-label="Close menu"
              onClick={onClose}
            >
              <Icon path={ICONS.x} />
            </button>
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => {
            onClose();
            void actions.library.create();
          }}
        >
          <Icon path={ICONS.plus} />
          New story
        </button>

        <div className="field sidebar-search">
          <input
            ref={searchRef}
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
                onClose();
                navigate({ kind: "story", id: summary.id });
              }}
              onRename={() => actions.library.startRename(summary.id, summary.title)}
              onDelete={() => actions.library.startDelete(summary.id, summary.title)}
            />
          ))}
        </nav>
      </aside>
    </>
  );
}

/** Visual polish (owner-facing screenshot review): the brand bar shows the
 * project folder name, not the full path — the full path stays available in
 * this element's `title` tooltip. Handles both `/` and `\` separators, since
 * `1667 web` also runs on Windows. */
function projectFolderName(projectRoot: string): string {
  const trimmed = projectRoot.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || projectRoot;
}
