import { createStoryIndex } from "../../shared/story-model.js";
import { isChapterSummary } from "../../shared/story-tree.js";
import type { Bookmark, NodeStub, StoryPayload } from "../../shared/types.js";
import type { FrameDeadlineCollector } from "./animation-deadline.js";

export type AtlasSort = "graph" | "size" | "recency" | "name";
export type AtlasLayoutSort = AtlasSort | "depth";
export type AtlasRowKind = "node" | "run" | "spacer" | "sketch" | "cold";

export interface AtlasRow {
  kind: AtlasRowKind; id: string; node: NodeStub; depth: number;
  fragment: string | null; cold: { lineCount: number; weeks: number } | null;
  active: boolean; cursor: boolean; bookmark: Bookmark | null;
  words: number; ownWords: number;
  /** The current reading line is the trunk at column 0; every other line hangs
   *  off it as a single collapsed **branch** stub, so the graph never grows a
   *  rail per line (spec §4: trunk pinned, forks open a rail, leaves close one).
   *  `connector` is `├─`/`└─` when several stubs share one fork. */
  branch: boolean;
  connector: "" | "├─" | "└─";
  /** A trunk `│` occupies this row's left column — true for runs and for a
   *  branch stub hanging off a fork above it, false only when there is no
   *  reading line at all (top-level stubs of a story with no active line). */
  hasTrunkColumn: boolean;
  run: number; lineEnd: boolean; forkCount: number;
  /** True on an `activeEnd` row whose line carries on below it. Such a row
   *  wears `◉ you` and ends the *reading* line, but the leaf beneath is the
   *  same logical line — counting both would draw two mass bars for one. */
  continuesBelow: boolean;
}
export interface AtlasLayout {
  rows: AtlasRow[]; allRows: AtlasRow[]; cursorId: string | null; sort: AtlasLayoutSort;
  totalLines: number; totalParts: number; forkCount: number;
  sketchCount: number; sketchForkCount: number; coldLines: number;
  massMaximum: number; moreRows: number;
  visibleStart: number; visibleEnd: number; totalRows: number;
}
export interface AtlasLayoutOptions {
  now: number; cursorId?: string | null; showSketches?: boolean;
  openedColdFolds?: ReadonlySet<string>; maxRows?: number; sort?: AtlasLayoutSort;
  deadlines?: FrameDeadlineCollector;
}
/** `activeEnd` marks a segment the reading line stops on while the node still
 *  has children — undo and stop-generation both leave the story there. Such a
 *  segment owns a row of its own so `◉ you` never disappears from the map. */
interface SegmentNode {
  anchor: NodeStub; end: NodeStub; children: VisualNode[];
  activeEnd: boolean; forkCount: number;
}
interface ColdNode { kind: "cold"; node: NodeStub; lineCount: number; weeks: number }
interface SketchNode { kind: "sketch"; node: NodeStub }
type VisualNode = { kind: "segment"; value: SegmentNode } | ColdNode | SketchNode;
interface DrawState {
  rows: AtlasRow[];
  depths: ReadonlyMap<string, number>; active: ReadonlySet<string>;
  words: ReadonlyMap<string, number>; bookmarks: ReadonlyMap<string, Bookmark>;
}
interface ClassifyFrame {
  nodes: readonly NodeStub[]; forkId: string; insideOpened: boolean; target: VisualNode[];
}

const DAY = 86_400_000;
const COLD_DAYS = 21;
export function createAtlasLayout(payload: StoryPayload, options: AtlasLayoutOptions): AtlasLayout {
  const index = createStoryIndex(payload);
  const activeIds = new Set(payload.path.map((node) => node.id));
  const activeLeafId = payload.path.at(-1)?.id ?? null;
  const opened = options.openedColdFolds ?? new Set<string>();
  const sort = options.sort ?? "graph";
  const lineChildren = (parentId: string | null): NodeStub[] =>
    (index.tree.childrenByParentId.get(parentId) ?? []).filter((node) => !isChapterSummary(node));
  const roots = lineChildren(null);
  const { visuals, sketchForks, coldLines } = createVisualTree({
    roots, lineChildren, activeIds, activeLeafId, opened,
    sketchNodeIds: index.mapSketchNodeIds, lineCountByNodeId: index.mapLineCountByNodeId,
    showSketches: options.showSketches === true, sort, now: options.now, deadlines: options.deadlines
  });
  const words = cumulativeWords(payload.nodes);
  const drawn = drawGraph(visuals, index.depthByNodeId, activeIds, words, index.bookmarkByNodeId);
  const massLines: AtlasRow[] = [];
  let massMaximum = 1;
  for (const row of drawn) {
    if (!isMassLine(row)) continue;
    massLines.push(row);
    massMaximum = Math.max(massMaximum, row.words);
  }
  // A stopped line has no mass row of its own, so `◉` and the cursor transfer to
  // the row that carries it: the next line end on the same rail, since the first
  // child keeps its parent's rail. `rememberedLeafId` cannot answer this —
  // `switchToNode({ stopAtNode: true })` clears the endpoint's `activeChildId`,
  // so a real stop has no remembered continuation to follow. Without the
  // transfer the mass view shows no "you are here" and Enter reroutes through
  // whatever sorted first.
  const stopIndex = drawn.findIndex((row) => row.continuesBelow);
  // Only a trunk node stops (`continuesBelow`); its line reads on down the
  // trunk, so the next non-branch mass line carries it. Keyed on the `branch`
  // flag, never a rail-id string a node could happen to equal.
  const massActiveId = stopIndex === -1 ? activeLeafId
    : drawn.slice(stopIndex + 1).find((row) => !row.branch && isMassLine(row))?.id ?? activeLeafId;
  let allRows = drawn;
  if (sort !== "graph") {
    massLines.sort((left, right) => {
      if (sort === "size") return right.words - left.words;
      if (sort === "recency") return Date.parse(right.node.lastTouched) - Date.parse(left.node.lastTouched);
      if (sort === "depth") return right.depth - left.depth || right.words - left.words;
      return massName(left).localeCompare(massName(right));
    });
    allRows = [...massLines.map((row) => row.id === massActiveId ? { ...row, active: true } : row),
      ...drawn.filter((row) => row.kind === "sketch")];
  }
  const selectable = (row: AtlasRow): boolean => selectableRow(row, sort);
  const home = sort === "graph" ? activeLeafId : massActiveId;
  const wanted = options.cursorId ?? home;
  const cursorId = allRows.some((row) => selectable(row) && row.id === wanted)
    ? wanted : allRows.find((row) => selectable(row) && row.id === home)?.id
      ?? allRows.find(selectable)?.id ?? null;
  allRows = allRows.map((row) => ({ ...row, cursor: selectable(row) && row.id === cursorId }));
  const maxRows = Math.max(1, options.maxRows ?? (allRows.length || 1));
  const cursorIndex = Math.max(0, allRows.findIndex((row) => row.cursor));
  const visibleStart = Number.isFinite(maxRows)
    ? Math.max(0, Math.min(cursorIndex - Math.floor(maxRows / 2), allRows.length - maxRows)) : 0;
  const rows = allRows.slice(visibleStart, Number.isFinite(maxRows) ? visibleStart + maxRows : undefined);
  // A cold row's weekly label changes pixels only while that row is visible.
  // Hot-to-cold transitions stay global below because folding can change
  // totals and window placement even when the source row is offscreen.
  for (const row of rows) {
    if (row.kind !== "cold") continue;
    const touched = Date.parse(row.node.lastTouched);
    if (Number.isFinite(touched)) {
      options.deadlines?.at(touched + (row.cold!.weeks + 1) * 7 * DAY);
    }
  }
  return {
    rows, allRows, cursorId, sort,
    totalLines: index.mapLineCount,
    totalParts: payload.nodes.filter((node) => !isChapterSummary(node)).length,
    forkCount: payload.nodes.filter((node) => !isChapterSummary(node) && node.childCount >= 2).length
      + Number(roots.length > 1),
    sketchCount: index.mapSketchNodeIds.size, sketchForkCount: sketchForks.size, coldLines,
    massMaximum,
    moreRows: Math.max(0, allRows.length - visibleStart - rows.length),
    visibleStart, visibleEnd: visibleStart + rows.length, totalRows: allRows.length
  };
}

interface VisualTreeOptions {
  roots: readonly NodeStub[];
  lineChildren: (parentId: string | null) => NodeStub[];
  activeIds: ReadonlySet<string>;
  activeLeafId: string | null;
  opened: ReadonlySet<string>;
  sketchNodeIds: ReadonlySet<string>;
  lineCountByNodeId: ReadonlyMap<string, number>;
  showSketches: boolean;
  sort: AtlasLayoutSort;
  now: number;
  deadlines?: FrameDeadlineCollector;
}

function createVisualTree(options: VisualTreeOptions): {
  visuals: VisualNode[]; sketchForks: ReadonlySet<string>; coldLines: number;
} {
  const visuals: VisualNode[] = [];
  const sketchForks = new Set<string>();
  let coldLines = 0;
  // Explicit work stack: story depth is user data and may exceed the JS call stack.
  const stack: ClassifyFrame[] = [
    { nodes: options.roots, forkId: "virtual-root", insideOpened: false, target: visuals }
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    // Copy before sorting so the shared story index remains immutable. The sort
    // is stable: the active continuation leads, all other sibling order stays.
    const ordered = [...frame.nodes].sort((left, right) =>
      Number(options.activeIds.has(right.id)) - Number(options.activeIds.has(left.id)));
    for (const anchor of ordered) {
      if (options.sketchNodeIds.has(anchor.id)) {
        sketchForks.add(frame.forkId);
        if (options.showSketches) frame.target.push({ kind: "sketch", node: anchor });
        continue;
      }
      const open = frame.insideOpened || options.opened.has(anchor.id);
      const days = ageDays(anchor.lastTouched, options.now);
      const touched = Date.parse(anchor.lastTouched);
      const canFoldCold = options.sort === "graph" && !open && !options.activeIds.has(anchor.id)
        && Number.isFinite(touched);
      if (canFoldCold && days <= COLD_DAYS) {
        options.deadlines?.at(touched + (COLD_DAYS + 1) * DAY);
      }
      if (options.sort === "graph" && days > COLD_DAYS && !open && !options.activeIds.has(anchor.id)) {
        const lineCount = options.lineCountByNodeId.get(anchor.id) ?? anchor.leafCount;
        coldLines += lineCount;
        frame.target.push({
          kind: "cold", node: anchor, lineCount, weeks: Math.floor(days / 7)
        });
        continue;
      }
      let end = anchor;
      // Never collapse past where the reader stands: stopped lines need a row.
      while (end.childCount === 1 && end.id !== options.activeLeafId) {
        const child = options.lineChildren(end.id)[0];
        if (child === undefined) break;
        end = child;
      }
      const structuralChildren = options.lineChildren(end.id);
      const children: VisualNode[] = [];
      frame.target.push({
        kind: "segment",
        value: {
          anchor, end, children, activeEnd: end.id === options.activeLeafId,
          // Structural count, not visible count: folded sketches still form a fork.
          forkCount: structuralChildren.length
        }
      });
      if (structuralChildren.length > 0) {
        stack.push({ nodes: structuralChildren, forkId: end.id, insideOpened: open, target: children });
      }
    }
    frame.target.sort((left, right) => Number(left.kind === "sketch") - Number(right.kind === "sketch"));
  }
  return { visuals, sketchForks, coldLines };
}

/** Which rows the cursor may land on. Shared so placement and movement cannot
 *  drift — a cursor parked where the down arrow can never reach it is unrecoverable. */
export function selectableRow(row: AtlasRow, sort: AtlasLayoutSort): boolean {
  return row.kind === "cold" || row.kind === "sketch"
    || row.kind === "node" && (sort === "graph" || row.lineEnd);
}
/** A logical line for the mass view: a line end that does not carry on below. */
function isMassLine(row: AtlasRow): boolean {
  return row.kind === "node" && row.lineEnd && !row.continuesBelow;
}

export function moveAtlasCursor(layout: AtlasLayout, direction: -1 | 1): string | null {
  const rows = layout.allRows.filter((row) => selectableRow(row, layout.sort));
  if (rows.length === 0) return null;
  const at = Math.max(0, rows.findIndex((row) => row.cursor));
  return rows[Math.max(0, Math.min(rows.length - 1, at + direction))]!.id;
}

export function followAtlasRail(layout: AtlasLayout): string | null {
  const at = layout.allRows.findIndex((row) => row.cursor);
  const row = layout.allRows[at];
  if (row === undefined) return null;
  // Only the trunk is a rail with more rows to follow; a stub is one row, so `l`
  // opens it elsewhere. Identity is the `branch` flag, never a node id — a node
  // named "trunk" must not read as the trunk itself.
  if (row.branch) return row.id;
  return layout.allRows.slice(at + 1).find((candidate) => !candidate.branch && candidate.kind === "node")?.id ?? row.id;
}

/** The trunk is the current reading line, pinned at column 0 and drawn with its
 *  runs and forks. Every other line hangs off it as a single collapsed stub, so
 *  the graph stays two columns wide instead of one rail per line (spec §4). */
function drawGraph(
  visuals: VisualNode[], depths: ReadonlyMap<string, number>,
  active: ReadonlySet<string>, words: ReadonlyMap<string, number>,
  bookmarks: ReadonlyMap<string, Bookmark>
): AtlasRow[] {
  const state: DrawState = { rows: [], depths, active, words, bookmarks };
  const trunkRoot = visuals.find(
    (visual): visual is Extract<VisualNode, { kind: "segment" }> =>
      visual.kind === "segment" && active.has(visual.value.anchor.id)
  ) ?? null;
  // A story with no reading line, or extra root lines beside it, has no fork to
  // hang those lines from — they lead as top-level stubs above the trunk.
  drawBranchGroup(visuals.filter((visual) => visual !== trunkRoot), state, trunkRoot !== null);
  drawTrunk(trunkRoot, state);
  return state.rows;
}

function drawTrunk(root: Extract<VisualNode, { kind: "segment" }> | null, state: DrawState): void {
  let seg: Extract<VisualNode, { kind: "segment" }> | null = root;
  let isRoot = true;
  // The walk descends one segment per iteration, so a deep line never recurses.
  while (seg !== null) {
    const { anchor, end, children, activeEnd, forkCount } = seg.value;
    const from = state.depths.get(anchor.id) ?? 1;
    const run = (state.depths.get(end.id) ?? from) - from;
    // The trunk continuation is the reading line's own next segment; a stop
    // (`activeEnd`) keeps the first child on the trunk so the line reads on.
    const cont = children[0]?.kind === "segment" ? children[0] : null;
    const branches = cont === null ? children : children.slice(1);
    if (isRoot) pushRow(state, "node", anchor, {
      lineEnd: anchor.id === end.id && (children.length === 0 || activeEnd),
      continuesBelow: anchor.id === end.id && activeEnd && cont !== null,
      forkCount: anchor.id === end.id ? forkCount : 0
    });
    if (run > 0) {
      pushRow(state, "spacer", end, { hasTrunkColumn: true });
      pushRow(state, "run", end, { hasTrunkColumn: true, run });
    }
    if (!isRoot || anchor.id !== end.id) pushRow(state, "node", end, {
      lineEnd: children.length === 0 || activeEnd,
      continuesBelow: activeEnd && cont !== null, forkCount
    });
    // A branch always hangs off the fork node just above it, so its `│` attaches
    // to the trunk whether or not the reading line carries on past the fork.
    drawBranchGroup(branches, state, true);
    seg = cont;
    isRoot = false;
  }
}

interface BranchEntry { kind: "node" | "sketch" | "cold"; node: NodeStub; cold: AtlasRow["cold"] }

/** Flatten every non-trunk branch to one row per line, then emit them together
 *  under the shared fork with `├─`/`└─` connectors. Sub-forks inside a branch
 *  collapse into their own lines rather than opening rails of their own. */
function drawBranchGroup(branches: readonly VisualNode[], state: DrawState, hasTrunkColumn: boolean): void {
  const entries = collapseBranches(branches);
  for (const [index, entry] of entries.entries()) {
    pushRow(state, entry.kind, entry.node, {
      branch: true, hasTrunkColumn, connector: index === entries.length - 1 ? "└─" : "├─",
      lineEnd: entry.kind === "node", cold: entry.cold,
      fragment: entry.kind === "sketch" ? `“${opening(entry.node.preview)}‥”` : null
    });
  }
}

function collapseBranches(branches: readonly VisualNode[]): BranchEntry[] {
  const entries: BranchEntry[] = [];
  const stack: VisualNode[] = [...branches].reverse();
  while (stack.length > 0) {
    const visual = stack.pop()!;
    if (visual.kind === "cold") {
      entries.push({ kind: "cold", node: visual.node, cold: { lineCount: visual.lineCount, weeks: visual.weeks } });
    } else if (visual.kind === "sketch") {
      entries.push({ kind: "sketch", node: visual.node, cold: null });
    } else {
      const children = visual.value.children;
      // The incoming line ends here only when nothing carries it on — a segment
      // continues it and a cold fold holds real lines of its own, so the
      // endpoint is a line of its own only when every child is a lone take
      // (sketch), or there are none. Those sketches then hang below it once `a`
      // reveals them, and must not replace it.
      if (children.every((child) => child.kind === "sketch")) {
        entries.push({ kind: "node", node: visual.value.end, cold: null });
      }
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
    }
  }
  return entries;
}

function pushRow(state: DrawState, kind: AtlasRowKind, node: NodeStub, extra: Partial<AtlasRow>): void {
  state.rows.push({
    kind, id: kind === "node" || kind === "cold" || kind === "sketch" ? node.id : `${node.id}:${kind}`,
    node, depth: state.depths.get(node.id) ?? 0, fragment: null, cold: null,
    active: state.active.has(node.id), cursor: false, bookmark: state.bookmarks.get(node.id) ?? null,
    words: state.words.get(node.id) ?? node.words, ownWords: node.words,
    branch: false, connector: "", hasTrunkColumn: false,
    run: 0, lineEnd: false, forkCount: 0, continuesBelow: false, ...extra
  });
}
/** The by-name sort key is the label the reader sees. Reimplementing the date
 *  format here would let unnamed lines order by something not on screen. */
function massName(row: AtlasRow): string {
  return row.bookmark?.name ?? `unnamed · ${shortDate(row.node.lastTouched)}`;
}
export function shortDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return `${date.getUTCDate()} ${["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][date.getUTCMonth()]}`;
}
function cumulativeWords(nodes: readonly NodeStub[]): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const node of nodes) totals.set(node.id, (node.parentId === null ? 0 : totals.get(node.parentId) ?? 0) + node.words);
  return totals;
}
function ageDays(value: string, now: number): number {
  const touched = Date.parse(value);
  return Number.isFinite(touched) ? Math.floor(Math.max(0, now - touched) / DAY) : 0;
}
function opening(value: string): string {
  return value.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
}
