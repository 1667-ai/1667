import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { rememberedLeafId } from "../../../shared/story-model.js";
import { useAppContext } from "../app/context.js";
import { activatesOnEnterOrSpace, resolveMapBinding } from "../app/keymap-dom.js";
import { pushKeyLayer } from "../app/keymap.js";
import { closeMap, openStoryPage } from "../app/router.js";
import { pushToast } from "../app/toasts.js";
import { useStore } from "../app/store.js";
import { GenerationBar } from "../generation/GenerationBar.js";
import { Icon, ICONS } from "../ui/icons.js";
import { SidebarToggle } from "../ui/SidebarToggle.js";
import { effectiveFocusedPartId, storyIdOf } from "../story/state.js";
import { MapFooter } from "./MapFooter.js";
import { MapList } from "./MapList.js";
import { handleMapKey, type MapKeyContext } from "./map-keys.js";
import {
  buildPathModel,
  buildTreeModel,
  mapStats,
  nodeDetail,
  pathLineKey,
  resolvePathCursor,
  resolveTreeCursor,
  type MapViewKind
} from "./map-view-model.js";
import { PathRow } from "./PathRow.js";
import { TreeRow } from "./MapRow.js";

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * `#/story/<id>/map`: the story's map as a page of its own. It replaces the
 * story's page (the sidebar stays), so everything the story page kept alive
 * is kept alive here: a running generation stays stoppable (the stop bar at
 * the bottom), and the story's own state, including an open editor's draft,
 * stays in the store.
 *
 * The cursor is plain state beside the layout, so moving it never rebuilds
 * the layout: only a change of payload, view, sketches, or folds does.
 */
export function StoryMap({ storyId, onOpenSidebar }: { readonly storyId: string; readonly onOpenSidebar: () => void }) {
  const { store, actions } = useAppContext();
  const story = useStore(store, (state) => (storyIdOf(state.story) === storyId ? state.story : null));
  const uid = useId();
  // The path view first, as in the TUI: the reader's own line, part by part.
  const [view, setView] = useState<MapViewKind>("path");
  const [showSketches, setShowSketches] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [awaiting, setAwaiting] = useState<string | null>(null);
  // Cold folds are judged against the moment the map opened, so a fold never
  // changes under the reader's cursor.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    void actions.story.load(storyId);
  }, [storyId, actions]);

  const loaded = story !== null && story.kind === "loaded" ? story : null;
  const payload = loaded?.payload ?? null;
  // Memoized: the focus walks the whole manuscript model, and a cursor move
  // must not pay for that.
  const focusedId = useMemo(() => (loaded === null ? null : effectiveFocusedPartId(loaded)), [loaded]);
  const leafId = payload?.path.at(-1)?.id ?? null;
  const wanted = cursor ?? focusedId ?? leafId;

  const tree = useMemo(
    () => (payload !== null && view === "tree" ? buildTreeModel(payload, { now, showSketches, openedColdFolds: opened }) : null),
    [payload, view, now, showSketches, opened]
  );
  const lineKey = payload !== null && view === "path" && wanted !== null ? pathLineKey(payload, wanted, showSketches) : null;
  const path = useMemo(
    () => (payload !== null && lineKey !== null ? buildPathModel(payload, lineKey, showSketches) : null),
    [payload, lineKey, showSketches]
  );
  const stats = useMemo(() => (payload === null ? null : mapStats(payload)), [payload]);

  let cursorId: string | null = null;
  if (payload !== null && tree !== null) cursorId = resolveTreeCursor(payload, tree, wanted, leafId);
  else if (path !== null && leafId !== null) cursorId = resolvePathCursor(path, wanted, leafId);

  const treeCursorRow = tree !== null && cursorId !== null ? tree.rows[tree.indexById.get(cursorId) ?? -1] : undefined;
  const coldLines = treeCursorRow?.kind === "cold" ? treeCursorRow.lineCount : null;
  const coldWeeks = treeCursorRow?.kind === "cold" ? treeCursorRow.weeks : 0;
  const detail = useMemo(
    () => (payload === null || cursorId === null
      ? null
      : nodeDetail(payload, cursorId, now, coldLines === null ? null : { lines: coldLines, weeks: coldWeeks })),
    [payload, cursorId, now, coldLines, coldWeeks]
  );

  // The latest render's values, for the key layer and the stable row callbacks
  // below (they must not change identity when only the cursor moves).
  const latest = useRef({ view, payload, tree, path, cursorId, showSketches });
  latest.current = { view, payload, tree, path, cursorId, showSketches };

  const close = useCallback(() => closeMap(storyId), [storyId]);

  const act = useCallback((nodeId?: string) => {
    const current = latest.current;
    const id = nodeId ?? current.cursorId;
    if (id === null || current.payload === null) return;
    const row = current.tree === null ? undefined : current.tree.rows[current.tree.indexById.get(id) ?? -1];
    if (row?.kind === "cold") {
      setOpened((previous) => new Set(previous).add(id));
      setCursor(rememberedLeafId(current.payload, id));
      return;
    }
    if (actions.story.switchLine(id)) setAwaiting(id);
  }, [actions]);

  const openRecords = useCallback(() => {
    const current = latest.current;
    if (current.payload === null || current.cursorId === null || !current.payload.nodes.some((node) => node.id === current.cursorId)) {
      pushToast(store, "no take to inspect here");
      return;
    }
    openStoryPage(storyId, { kind: "records", nodeId: current.cursorId });
  }, [store, storyId]);

  const toggleView = useCallback(() => {
    const current = latest.current;
    if (current.cursorId !== null) setCursor(current.cursorId);
    setView((previous) => (previous === "tree" ? "path" : "tree"));
  }, []);
  const toggleSketches = useCallback(() => {
    setShowSketches((previous) => !previous);
    setFocusToken((previous) => previous + 1);
  }, []);
  const selectRow = useCallback((index: number) => {
    const row = latest.current.tree?.rows[index];
    if (row !== undefined) setCursor(row.id);
  }, []);
  const actRow = useCallback((index: number) => {
    const row = latest.current.tree?.rows[index];
    if (row !== undefined) act(row.id);
  }, [act]);
  const selectPathRow = useCallback((index: number, nodeId: string | null) => {
    const current = latest.current;
    const row = current.path?.layout.rows[index];
    if (row === undefined) return;
    const inRow = current.cursorId !== null && current.path?.rowOfNode.get(current.cursorId) === index;
    setCursor(nodeId ?? (inRow ? current.cursorId : row.pathNode.id));
  }, []);
  const actPathRow = useCallback((index: number) => {
    const row = latest.current.path?.layout.rows[index];
    if (row !== undefined) act(latest.current.cursorId ?? row.pathNode.id);
  }, [act]);

  // The map's keys sit on top of the story's; Esc closes the map even while a
  // generation runs (the stop bar below stops it).
  useEffect(() => pushKeyLayer({
    resolve: (event) => resolveMapBinding(event, latest.current.view),
    claimsEscape: true,
    handle: (binding) => {
      const current = latest.current;
      if (current.payload === null) return binding.action === "cancel" ? (close(), true) : false;
      // A focused button gives Enter its own meaning.
      if (binding.action === "apply" && activatesOnEnterOrSpace()) return false;
      const context: MapKeyContext = {
        view: current.view, payload: current.payload, tree: current.tree, path: current.path,
        cursorId: current.cursorId, showSketches: current.showSketches,
        setCursor, toggleView, toggleSketches, act: () => act(), close, openRecords
      };
      return handleMapKey(binding, context);
    }
  }), [act, close, openRecords, toggleSketches, toggleView]);

  // A switch from the map lands (or fails) asynchronously: the map closes
  // once the line runs through the node, and stays put on a failure.
  useEffect(() => {
    if (awaiting === null || loaded === null || loaded.switching !== null) return;
    setAwaiting(null);
    if (loaded.payload.path.some((node) => node.id === awaiting)) close();
  }, [awaiting, loaded, close]);

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

  const activeIndex = tree !== null && cursorId !== null
    ? tree.indexById.get(cursorId) ?? -1
    : path !== null && cursorId !== null ? path.rowOfNode.get(cursorId) ?? -1 : -1;
  const domId = (index: number): string => `${uid}-row-${index}`;
  const statsText = stats === null ? "" : [
    plural(stats.lines, "line", "lines"),
    plural(stats.parts, "part", "parts"),
    plural(stats.forks, "fork", "forks")
  ].join(" · ") + (tree !== null && tree.coldLines > 0 ? ` · ${plural(tree.coldLines, "cold line", "cold lines")}` : "");

  return (
    <div className="story-view story-map">
      <header className="story-header map-header">
        <SidebarToggle onOpen={onOpenSidebar} />
        <div className="story-identity">
          <span className="story-kicker map-kicker">{story.payload.title}</span>
          <div className="story-title-wrap"><h1 className="story-title">Map</h1></div>
          <span className="story-stats map-stats">{statsText}</span>
        </div>
        <div className="story-actions map-actions">
          <div className="map-views" role="group" aria-label="Map view">
            <button
              type="button"
              className="btn btn-ghost btn-small"
              aria-pressed={view === "tree"}
              title="Tree (m)"
              onClick={() => { if (view !== "tree") toggleView(); setFocusToken((value) => value + 1); }}
            >
              Tree
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small"
              aria-pressed={view === "path"}
              title="Path (m)"
              onClick={() => { if (view !== "path") toggleView(); setFocusToken((value) => value + 1); }}
            >
              Path
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            aria-pressed={showSketches}
            title="Sketches (a)"
            onClick={toggleSketches}
          >
            Sketches
          </button>
          <button type="button" className="icon-btn" title="Close map (Esc)" aria-label="Close map (Esc)" onClick={close}>
            <Icon path={ICONS.x} />
          </button>
        </div>
      </header>
      {story.payload.nodes.length === 0 || cursorId === null
        ? <p className="story-empty">Nothing to map yet.</p>
        : (
          <>
            {tree !== null && (
              <MapList
                label="Story map"
                count={tree.rows.length}
                thin={tree.thin}
                activeIndex={activeIndex}
                activeDomId={activeIndex >= 0 ? domId(activeIndex) : null}
                focusToken={focusToken}
                renderRow={(index, top, height) => {
                  const row = tree.rows[index]!;
                  const position = (tree.positionById.get(row.id) ?? -1) + 1;
                  return (
                    <TreeRow
                      key={row.id}
                      row={row}
                      index={index}
                      top={top}
                      height={height}
                      laneCount={tree.laneCount}
                      overflow={tree.overflow}
                      selected={position > 0 && index === activeIndex}
                      position={position}
                      size={tree.selectable.length}
                      domId={domId(index)}
                      chapter={tree.chapters.get(row.id) ?? null}
                      onSelect={selectRow}
                      onAct={actRow}
                      onToggleSketches={toggleSketches}
                    />
                  );
                }}
              />
            )}
            {path !== null && (
              <MapList
                label="Story map"
                count={path.layout.rows.length}
                thin={null}
                activeIndex={activeIndex}
                activeDomId={activeIndex >= 0 ? domId(activeIndex) : null}
                focusToken={focusToken}
                renderRow={(index, top, height) => {
                  const row = path.layout.rows[index]!;
                  const selected = index === activeIndex;
                  return (
                    <PathRow
                      key={row.pathNode.id}
                      row={row}
                      index={index}
                      top={top}
                      height={height}
                      selected={selected}
                      cursorId={selected ? cursorId : null}
                      position={index + 1}
                      size={path.layout.rows.length}
                      domId={domId(index)}
                      chapter={path.chapters.get(row.pathNode.id) ?? null}
                      onSelect={selectPathRow}
                      onAct={actPathRow}
                    />
                  );
                }}
              />
            )}
            <MapFooter detail={detail} busy={loaded?.switching != null} onAct={() => act()} />
          </>
        )}
      <GenerationBar />
    </div>
  );
}
