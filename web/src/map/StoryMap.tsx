import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { isFactStateful } from "../../../shared/fact-state.js";
import { factName } from "../../../shared/fact-view.js";
import { laneFollowIndex } from "../../../shared/lane-layout.js";
import { factLensAnchorForRows, factLensNode, factLensStateAtNode, type FactLensNode } from "../../../shared/map-fact-lens.js";
import { massSortTitle, nextMassSort, type MapMassSort } from "../../../shared/map-model.js";
import { REFERENCE_BINDINGS } from "../../../shared/reference-bindings.js";
import { createStoryIndex, rememberedLeafId } from "../../../shared/story-model.js";
import { useAppContext } from "../app/context.js";
import { activatesOnEnterOrSpace, resolveMapBinding } from "../app/keymap-dom.js";
import { pushKeyLayer } from "../app/keymap.js";
import { closeMap, openStoryPage } from "../app/router.js";
import { pushToast } from "../app/toasts.js";
import { useStore } from "../app/store.js";
import { GenerationBar } from "../generation/GenerationBar.js";
import { isGenerationActive } from "../generation/state.js";
import { PART_WRITING_TOAST } from "../story/part-policy.js";
import { PruneDialog } from "../story/PruneDialog.js";
import { effectiveFocusedPartId, storyIdOf } from "../story/state.js";
import { TagPopover } from "../tags/TagPopover.js";
import { Icon, ICONS } from "../ui/icons.js";
import { SidebarToggle } from "../ui/SidebarToggle.js";
import { usePopover } from "../ui/usePopover.js";
import { MapFooter, type FooterAction } from "./MapFooter.js";
import { MapList } from "./MapList.js";
import { MassRow } from "./MassRow.js";
import { handleMapKey, type MapKeyContext } from "./map-keys.js";
import {
  buildMassModel,
  buildPathModel,
  buildTreeModel,
  mapStats,
  nodeDetail,
  pathLineKey,
  resolveMassCursor,
  resolvePathCursor,
  resolveTreeCursor,
  type MapViewKind
} from "./map-view-model.js";
import { isPendingTake, streamTargetOf, withPendingTake, type MapRun } from "./pending-take.js";
import { PathRow } from "./PathRow.js";
import { TreeRow } from "./MapRow.js";

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

const VIEW_ORDER: readonly MapViewKind[] = ["path", "tree", "mass"];
const VIEW_LABEL: Readonly<Record<MapViewKind, string>> = { path: "Path", tree: "Tree", mass: "Mass" };

const NO_FACTS_TOAST = "No Facts to lens.";
const NO_ANCHOR_TOAST = "This Fact has no visible anchor.";
const NO_STATE_TOAST = "This Fact has no state here.";

/**
 * `#/story/<id>/map`: the story's map as a page of its own. It replaces the
 * story's page (the sidebar stays), so everything the story page kept alive
 * is kept alive here: a running generation stays stoppable (the stop bar at
 * the bottom), and the story's own state, including an open editor's draft,
 * stays in the store.
 *
 * The cursor is plain state beside the layout, so moving it never rebuilds
 * the layout: only a change of payload, view, sort, sketches, or folds does.
 * A take being written is drawn from a text-free pending node, so the frames
 * of a stream never rebuild it either.
 */
export function StoryMap({ storyId, onOpenSidebar }: { readonly storyId: string; readonly onOpenSidebar: () => void }) {
  const { store, actions } = useAppContext();
  const story = useStore(store, (state) => (storyIdOf(state.story) === storyId ? state.story : null));
  const uid = useId();
  // The path view first, as in the TUI: the reader's own line, part by part.
  const [view, setView] = useState<MapViewKind>("path");
  const [sort, setSort] = useState<MapMassSort>("size");
  const [showSketches, setShowSketches] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [lensFactId, setLensFactId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [awaiting, setAwaiting] = useState<string | null>(null);
  // A part to focus on the story's page once a switch from the lens lands.
  const focusAfter = useRef<string | null>(null);
  const deletedParent = useRef<string | null>(null);
  // Cold folds are judged against the moment the map opened, so a fold never
  // changes under the reader's cursor.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    void actions.story.load(storyId);
  }, [storyId, actions]);

  // The run that writes into this story, as plain values so a frame of its
  // text (which changes the generation state) never re-renders the map.
  const runGenId = useStore(store, (state) => (
    isGenerationActive(state.generation) && state.generation.storyId === storyId ? state.generation.genId : null
  ));
  const runMode = useStore(store, (state) => (isGenerationActive(state.generation) ? state.generation.mode : null));
  const runAppendTo = useStore(store, (state) => (isGenerationActive(state.generation) ? state.generation.appendTo : null));
  const runParent = useStore(store, (state) => (isGenerationActive(state.generation) ? state.generation.parentId : null));
  const runInstruction = useStore(store, (state) => (isGenerationActive(state.generation) ? state.generation.instruction : ""));
  const run = useMemo<MapRun | null>(() => (
    runGenId === null || runMode === null
      ? null
      : { genId: runGenId, mode: runMode, appendTo: runAppendTo, parentId: runParent, instruction: runInstruction }
  ), [runGenId, runMode, runAppendTo, runParent, runInstruction]);
  const runStartedAt = useMemo(() => new Date().toISOString(), [runGenId]);
  const streamId = streamTargetOf(run);

  const loaded = story !== null && story.kind === "loaded" ? story : null;
  const authoritative = loaded?.payload ?? null;
  const payload = useMemo(
    () => (authoritative === null ? null : withPendingTake(authoritative, run, runStartedAt)),
    [authoritative, run, runStartedAt]
  );
  const nodesById = useMemo(() => (payload === null ? null : createStoryIndex(payload).tree.nodesById), [payload]);
  // Memoized: the focus walks the whole manuscript model, and a cursor move
  // must not pay for that.
  const focusedId = useMemo(() => (loaded === null ? null : effectiveFocusedPartId(loaded)), [loaded]);
  const leafId = payload?.path.at(-1)?.id ?? null;
  // A cursor on a take that is gone (a pending take that landed or stopped, a
  // deleted take) falls back to the focused part.
  const wanted = (cursor !== null && nodesById?.has(cursor) === true ? cursor : null) ?? focusedId ?? leafId;

  const tree = useMemo(
    () => (payload !== null && view === "tree" ? buildTreeModel(payload, { now, showSketches, openedColdFolds: opened }) : null),
    [payload, view, now, showSketches, opened]
  );
  const mass = useMemo(
    () => (payload !== null && view === "mass" ? buildMassModel(payload, { now, showSketches, sort }) : null),
    [payload, view, now, showSketches, sort]
  );
  const lineKey = payload !== null && view === "path" && wanted !== null ? pathLineKey(payload, wanted, showSketches) : null;
  const path = useMemo(
    () => (payload !== null && lineKey !== null ? buildPathModel(payload, lineKey, showSketches) : null),
    [payload, lineKey, showSketches]
  );
  const stats = useMemo(() => (payload === null ? null : mapStats(payload)), [payload]);

  let cursorId: string | null = null;
  if (payload !== null && tree !== null) cursorId = resolveTreeCursor(payload, tree, wanted, leafId);
  else if (payload !== null && mass !== null) cursorId = resolveMassCursor(payload, mass, wanted, leafId);
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

  // The Fact lens: one Fact read against every row of the tree.
  const lensFact = view === "tree" && lensFactId !== null && payload !== null
    ? payload.facts.find((fact) => fact.id === lensFactId) ?? null
    : null;
  useEffect(() => {
    if (lensFactId !== null && lensFact === null) setLensFactId(null);
  }, [lensFactId, lensFact]);
  // One reading per row, kept so a memoized row sees the same object until
  // the story or the Fact changes.
  const lensRows = useMemo(() => new Map<string, FactLensNode | null>(), [payload, lensFact]);
  const lensOf = (id: string): FactLensNode | null => {
    if (lensFact === null || payload === null) return null;
    if (!lensRows.has(id)) lensRows.set(id, factLensNode(lensFact, createStoryIndex(payload), id));
    return lensRows.get(id) ?? null;
  };

  // The latest render's values, for the key layer and the stable row callbacks
  // below (they must not change identity when only the cursor moves).
  const latest = useRef({ view, payload, tree, path, mass, cursorId, showSketches, lensFact });
  latest.current = { view, payload, tree, path, mass, cursorId, showSketches, lensFact };

  const close = useCallback(() => closeMap(storyId), [storyId]);

  const act = useCallback((nodeId?: string) => {
    const current = latest.current;
    const id = nodeId ?? current.cursorId;
    if (id === null || current.payload === null) return;
    if (isPendingTake(id)) {
      pushToast(store, PART_WRITING_TOAST);
      return;
    }
    const row = current.tree === null ? undefined : current.tree.rows[current.tree.indexById.get(id) ?? -1];
    if (row?.kind === "cold") {
      setOpened((previous) => new Set(previous).add(id));
      setCursor(rememberedLeafId(current.payload, id));
      return;
    }
    if (actions.story.switchLine(id)) setAwaiting(id);
  }, [actions, store]);

  const openRecords = useCallback(() => {
    const current = latest.current;
    if (current.payload === null || current.cursorId === null || !current.payload.nodes.some((node) => node.id === current.cursorId)) {
      pushToast(store, "no take to inspect here");
      return;
    }
    openStoryPage(storyId, { kind: "records", nodeId: current.cursorId });
  }, [store, storyId]);

  const selectView = useCallback((next: MapViewKind) => {
    const current = latest.current;
    if (current.cursorId !== null) setCursor(current.cursorId);
    setLensFactId(null);
    setView(next);
    setFocusToken((value) => value + 1);
  }, []);
  const toggleView = useCallback(() => {
    selectView(VIEW_ORDER[(VIEW_ORDER.indexOf(latest.current.view) + 1) % VIEW_ORDER.length]!);
  }, [selectView]);
  const toggleSketches = useCallback(() => {
    setShowSketches((previous) => !previous);
    setFocusToken((previous) => previous + 1);
  }, []);
  const cycleSort = useCallback(() => {
    setSort(nextMassSort);
    setFocusToken((previous) => previous + 1);
  }, []);
  const selectRow = useCallback((index: number) => {
    const current = latest.current;
    const row = current.tree?.rows[index];
    if (row !== undefined) setCursor(row.id);
    const item = current.mass?.items[index];
    if (item?.kind === "row") setCursor(item.row.id);
  }, []);
  const actRow = useCallback((index: number) => {
    const current = latest.current;
    const row = current.tree?.rows[index];
    if (row !== undefined) act(row.id);
    const item = current.mass?.items[index];
    if (item?.kind === "row") act(item.row.id);
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

  /** Opens a row's line in the path view at that take. A sketch only shows
   * with sketches on, so they come on with it. */
  const openInPath = useCallback((id: string, sketch: boolean) => {
    setCursor(id);
    if (sketch) setShowSketches(true);
    setLensFactId(null);
    setView("path");
    setFocusToken((value) => value + 1);
  }, []);
  const hideLanes = useCallback(() => {
    const current = latest.current;
    const row = current.tree === null || current.cursorId === null
      ? undefined
      : current.tree.rows[current.tree.indexById.get(current.cursorId) ?? -1];
    if (row === undefined) selectView("path");
    else openInPath(row.id, row.kind === "sketch");
  }, [openInPath, selectView]);
  const follow = useCallback(() => {
    const current = latest.current;
    if (current.cursorId === null) return;
    if (current.view === "tree" && current.tree !== null) {
      const index = current.tree.indexById.get(current.cursorId);
      const row = index === undefined ? undefined : current.tree.rows[index];
      if (index === undefined || row === undefined) return;
      if (row.kind === "cold") act(row.id);
      // Lane 0 is the reading line: `l` walks it down. Any other lane has
      // nowhere further to walk within the tree, so it opens in the path view.
      else if (row.lane === 0) {
        const to = laneFollowIndex(current.tree.rows, index);
        if (to !== null) setCursor(current.tree.rows[to]!.id);
      } else openInPath(row.id, row.kind === "sketch");
    } else if (current.view === "mass" && current.mass !== null) {
      const item = current.mass.items[current.mass.indexById.get(current.cursorId) ?? -1];
      if (item?.kind === "row") openInPath(item.row.id, item.row.kind === "sketch");
    }
  }, [act, openInPath]);

  // ----- the Fact lens -----
  const openLens = useCallback(() => {
    const current = latest.current;
    if (current.view !== "tree" || current.payload === null) return;
    const first = current.payload.facts[0];
    if (first === undefined) pushToast(store, NO_FACTS_TOAST);
    else setLensFactId(first.id);
  }, [store]);
  const closeLens = useCallback(() => setLensFactId(null), []);
  const cycleLens = useCallback(() => {
    const current = latest.current;
    if (current.payload === null || current.lensFact === null) return;
    const facts = current.payload.facts;
    const at = facts.findIndex((fact) => fact.id === current.lensFact!.id);
    setLensFactId(facts[(at + 1) % facts.length]?.id ?? null);
  }, []);
  const openLensAnchor = useCallback(() => {
    const current = latest.current;
    if (current.payload === null || current.lensFact === null || current.tree === null) return;
    const rows = current.tree.selectable.map((index) => current.tree!.rows[index]!);
    const anchor = factLensAnchorForRows(current.lensFact, rows, current.cursorId);
    if (anchor === null) {
      pushToast(store, NO_ANCHOR_TOAST);
      return;
    }
    if (current.payload.path.some((node) => node.id === anchor.nodeId)) {
      actions.story.focusPart(anchor.nodeId);
      close();
      return;
    }
    // An anchor on another line: switch to it, then focus it on the page.
    focusAfter.current = anchor.nodeId;
    act(anchor.nodeId);
  }, [act, actions, close, store]);
  const editLensState = useCallback(() => {
    const current = latest.current;
    if (current.payload === null || current.lensFact === null) return;
    const state = factLensStateAtNode(current.lensFact, current.payload, current.cursorId);
    if (state === null) {
      pushToast(store, NO_STATE_TOAST);
      return;
    }
    // The fact editor lives in the story's Facts panel: open it there.
    actions.facts.open(current.lensFact.id);
    if (isFactStateful(current.lensFact)) actions.facts.openState(state.id);
    if (store.get().facts.editor !== null) close();
  }, [actions, close, store]);

  // ----- `D` and `t` in the path view -----
  const askDelete = useCallback(() => {
    const current = latest.current;
    if (current.view !== "path" || current.cursorId === null || current.payload === null) return;
    if (isPendingTake(current.cursorId)) {
      pushToast(store, PART_WRITING_TOAST);
      return;
    }
    deletedParent.current = createStoryIndex(current.payload).tree.nodesById.get(current.cursorId)?.parentId ?? null;
    actions.part.askDeleteNode(current.cursorId);
  }, [actions, store]);
  const tagLine = useCallback(() => {
    const current = latest.current;
    if (current.view !== "path" || current.cursorId === null) return;
    if (isPendingTake(current.cursorId)) {
      pushToast(store, PART_WRITING_TOAST);
      return;
    }
    actions.tags.openForNode(current.cursorId);
  }, [actions, store]);

  // The map's keys sit on top of the story's; Esc closes the map even while a
  // generation runs (the stop bar below stops it).
  useEffect(() => pushKeyLayer({
    resolve: (event) => {
      // While the lens is open, `e` is "edit state" (the NAV table's edit).
      if (latest.current.lensFact !== null && event.key === "e" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        return REFERENCE_BINDINGS.navEdit;
      }
      return resolveMapBinding(event, latest.current.view);
    },
    claimsEscape: true,
    handle: (binding) => {
      const current = latest.current;
      if (current.payload === null) return binding.action === "cancel" ? (close(), true) : false;
      // A focused button gives Enter its own meaning.
      if (binding.action === "apply" && activatesOnEnterOrSpace()) return false;
      const context: MapKeyContext = {
        view: current.view, payload: current.payload, tree: current.tree, path: current.path, mass: current.mass,
        lensActive: current.lensFact !== null,
        cursorId: current.cursorId, showSketches: current.showSketches,
        setCursor, toggleView, toggleSketches, act: () => act(), close,
        hideLanes, follow, cycleSort, openLens, closeLens, cycleLens, openLensAnchor, editLensState, askDelete, tagLine, openRecords
      };
      return handleMapKey(binding, context);
    }
  }), [act, close, toggleSketches, toggleView, hideLanes, follow, cycleSort, openLens, closeLens, cycleLens,
    openLensAnchor, editLensState, askDelete, tagLine, openRecords]);

  // A switch from the map lands (or fails) asynchronously: the map closes
  // once the line runs through the node, and stays put on a failure.
  useEffect(() => {
    if (awaiting === null || loaded === null || loaded.switching !== null) return;
    setAwaiting(null);
    if (loaded.payload.path.some((node) => node.id === awaiting)) {
      if (focusAfter.current !== null) actions.story.focusPart(focusAfter.current);
      focusAfter.current = null;
      close();
    } else focusAfter.current = null;
  }, [awaiting, loaded, close, actions]);

  // A deleted cursor take moves the cursor to its parent.
  useEffect(() => {
    if (cursor === null || nodesById === null || nodesById.has(cursor)) return;
    setCursor(isPendingTake(cursor) ? null : deletedParent.current);
  }, [cursor, nodesById]);

  // The delete confirm and the tag popover are the story page's own; they
  // open here for the path view's `D` and `t`.
  const deletePlan = useStore(store, (state) => (
    state.partUi.deletePlan !== null && state.partUi.deletePlan.storyId === storyId ? state.partUi.deletePlan : null
  ));
  const deleting = useStore(store, (state) => state.partUi.deleting);
  const tagOpen = useStore(store, (state) => (
    state.tags.open !== null && state.tags.open.storyId === storyId ? state.tags.open : null
  ));
  const tagPopover = usePopover({
    open: tagOpen !== null,
    setOpen: (next) => { if (!next) actions.tags.close(); }
  });
  const dialogOpen = deletePlan !== null || tagOpen !== null;
  const wasDialogOpen = useRef(false);
  useEffect(() => {
    // Closing a dialog hands the keyboard back to the list.
    if (wasDialogOpen.current && !dialogOpen) setFocusToken((value) => value + 1);
    wasDialogOpen.current = dialogOpen;
  }, [dialogOpen]);

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

  let activeIndex = -1;
  if (cursorId !== null) {
    if (tree !== null) activeIndex = tree.indexById.get(cursorId) ?? -1;
    else if (mass !== null) activeIndex = mass.indexById.get(cursorId) ?? -1;
    else if (path !== null) activeIndex = path.rowOfNode.get(cursorId) ?? -1;
  }
  const domId = (index: number): string => `${uid}-row-${index}`;
  const statsText = stats === null ? "" : [
    plural(stats.lines, "line", "lines"),
    plural(stats.parts, "part", "parts"),
    plural(stats.forks, "fork", "forks")
  ].join(" · ") + (tree !== null && tree.coldLines > 0 ? ` · ${plural(tree.coldLines, "cold line", "cold lines")}` : "");
  const pendingCursor = isPendingTake(cursorId);
  const footerExtras: FooterAction[] = [];
  if (lensFact === null) {
    if (view === "path") {
      footerExtras.push(
        { label: "Tag", title: "Tag this line (t)", disabled: pendingCursor, onClick: tagLine },
        { label: "Delete", title: "Delete this take (D)", disabled: pendingCursor, onClick: askDelete }
      );
    } else if (view === "tree") {
      footerExtras.push(
        { label: "Open in path", title: "Open in the path view (Tab)", onClick: hideLanes },
        { label: "Follow", title: "Follow the line (l)", onClick: follow }
      );
    } else {
      footerExtras.push({ label: "Open line", title: "Open the line in the path view (l)", onClick: follow });
    }
  }
  const lensIndex = lensFact === null || payload === null ? 0 : payload.facts.findIndex((fact) => fact.id === lensFact.id) + 1;

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
            {VIEW_ORDER.map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn btn-ghost btn-small"
                aria-pressed={view === kind}
                title={`${VIEW_LABEL[kind]} (m)`}
                onClick={() => { if (view !== kind) selectView(kind); else setFocusToken((value) => value + 1); }}
              >
                {VIEW_LABEL[kind]}
              </button>
            ))}
          </div>
          {view === "mass" && (
            <button type="button" className="btn btn-ghost btn-small" title="Change the order (s)" onClick={cycleSort}>
              Sort: {massSortTitle(sort)}
            </button>
          )}
          {view === "tree" && (
            <button
              type="button"
              className="btn btn-ghost btn-small"
              aria-pressed={lensFact !== null}
              title="Fact lens (f)"
              onClick={() => { if (lensFact === null) openLens(); else closeLens(); setFocusToken((value) => value + 1); }}
            >
              Lens
            </button>
          )}
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
        {tagOpen !== null && (
          <div className="map-tag-wrap" ref={tagPopover.containerRef}>
            <TagPopover payload={story.payload} target={tagOpen} />
          </div>
        )}
      </header>
      {lensFact !== null && payload !== null && (
        <div className="map-lens" role="region" aria-label="Fact lens">
          <span className="map-lens-name">{factName(lensFact, payload.path.map((node) => node.id))}</span>
          <span className="map-meta">Fact {lensIndex} of {payload.facts.length}</span>
          <span className="map-lens-actions">
            <button type="button" className="btn btn-ghost btn-small" title="Next Fact (Tab)" onClick={() => { cycleLens(); setFocusToken((value) => value + 1); }}>
              Next Fact
            </button>
            <button type="button" className="btn btn-ghost btn-small" title="Go to the anchor (Enter)" onClick={openLensAnchor}>
              Go to anchor
            </button>
            <button type="button" className="btn btn-ghost btn-small" title="Edit the state here (e)" onClick={editLensState}>
              Edit state
            </button>
            <button type="button" className="btn btn-ghost btn-small" title="Close the lens (Esc)" onClick={() => { closeLens(); setFocusToken((value) => value + 1); }}>
              Close lens
            </button>
          </span>
        </div>
      )}
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
                  const hasNode = row.kind === "node" || row.kind === "end" || row.kind === "sketch" || row.kind === "cold";
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
                      streaming={streamId !== null && (row.kind === "node" || row.kind === "end") && row.node.id === streamId}
                      lens={hasNode ? lensOf(row.id) : null}
                      onSelect={selectRow}
                      onAct={actRow}
                      onToggleSketches={toggleSketches}
                    />
                  );
                }}
              />
            )}
            {mass !== null && (
              <MapList
                label="Story map"
                count={mass.items.length}
                thin={null}
                activeIndex={activeIndex}
                activeDomId={activeIndex >= 0 ? domId(activeIndex) : null}
                focusToken={focusToken}
                renderRow={(index, top, height) => {
                  const item = mass.items[index]!;
                  const rowId = item.kind === "row" ? item.row.id : null;
                  const position = rowId === null ? 0 : (mass.positionById.get(rowId) ?? -1) + 1;
                  return (
                    <MassRow
                      key={rowId ?? "sketch-fold"}
                      item={item}
                      index={index}
                      top={top}
                      height={height}
                      selected={position > 0 && index === activeIndex}
                      position={position}
                      size={mass.selectable.length}
                      domId={domId(index)}
                      maximum={mass.massMaximum}
                      streaming={streamId !== null && rowId === streamId}
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
                      streamId={streamId}
                      onSelect={selectPathRow}
                      onAct={actPathRow}
                    />
                  );
                }}
              />
            )}
            <MapFooter detail={detail} busy={loaded?.switching != null || pendingCursor} onAct={() => act()} extras={footerExtras} />
          </>
        )}
      <GenerationBar />
      {deletePlan !== null && (
        <PruneDialog
          plan={deletePlan}
          deleting={deleting}
          onCancel={actions.part.cancelDelete}
          onDelete={() => { void actions.part.confirmDelete(); }}
        />
      )}
    </div>
  );
}
