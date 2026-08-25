import { createStoryIndex } from "../../shared/story-model.js";
import { isChapterSummary } from "../../shared/story-tree.js";
import type { Tag, NodeStub, StoryPayload } from "../../shared/types.js";
import { ageDays, cumulativeWords, COLD_DAYS, DAY } from "./map-cold.js";
import { windowRows } from "./map-window.js";
import { opening } from "./screens/map-row-labels.js";
import type { MapMassSort } from "./map-state.js";
import type { FrameDeadlineCollector } from "./animation-deadline.js";

/** The mass view's own sort order. The local-camera "graph" sort doc "10a"
 *  replaced with the lane tree is gone — every production caller already
 *  passes one of these. */
export type AtlasLayoutSort = MapMassSort;
export type AtlasRowKind = "node" | "sketch";

export interface AtlasRow {
  kind: AtlasRowKind; id: string; node: NodeStub; depth: number;
  fragment: string | null;
  active: boolean; cursor: boolean; tag: Tag | null;
  words: number; ownWords: number;
  /** Untouched past the cold threshold — dims a line's bar (doc 26a). */
  stale: boolean;
  /** The current reading line is the trunk at column 0; every other line hangs
   *  off it as a single collapsed **branch** stub, so the graph never grows a
   *  rail per line. Read only by `massActiveId` below, not by any renderer. */
  branch: boolean;
  lineEnd: boolean;
  /** True on an `activeEnd` row whose line carries on below it. Such a row
   *  wears `◉ you` and ends the *reading* line, but the leaf beneath is the
   *  same logical line — counting both would draw two mass bars for one. Read
   *  only by `massActiveId` below, not by any renderer. */
  continuesBelow: boolean;
}
export interface AtlasLayout {
  rows: AtlasRow[]; allRows: AtlasRow[]; cursorId: string | null; sort: AtlasLayoutSort;
  totalLines: number; totalParts: number; forkCount: number; storyWords: number;
  sketchCount: number;
  /** Words across the sketches — the weight doc 26a's fold row reports. */
  sketchWords: number;
  massMaximum: number; moreRows: number;
  visibleStart: number; visibleEnd: number; totalRows: number;
}
export interface AtlasLayoutOptions {
  now: number; cursorId?: string | null; showSketches?: boolean;
  maxRows?: number; sort: AtlasLayoutSort;
  deadlines?: FrameDeadlineCollector;
}
/** `activeEnd` marks a segment the reading line stops on while the node still
 *  has children — stopping a generation and summarising both leave the story
 *  there. Such a segment owns a row of its own so `◉ you` never disappears from
 *  the map. */
interface SegmentNode {
  anchor: NodeStub; end: NodeStub; children: VisualNode[];
  activeEnd: boolean;
}
interface SketchNode { kind: "sketch"; node: NodeStub }
type VisualNode = { kind: "segment"; value: SegmentNode } | SketchNode;
interface DrawState {
  rows: AtlasRow[];
  depths: ReadonlyMap<string, number>; active: ReadonlySet<string>;
  words: ReadonlyMap<string, number>; tags: ReadonlyMap<string, Tag>;
  now: number;
}
interface ClassifyFrame {
  nodes: readonly NodeStub[]; target: VisualNode[];
}

export function createAtlasLayout(payload: StoryPayload, options: AtlasLayoutOptions): AtlasLayout {
  const index = createStoryIndex(payload);
  const activeIds = new Set(payload.path.map((node) => node.id));
  const activeLeafId = payload.path.at(-1)?.id ?? null;
  const sort = options.sort;
  const lineChildren = (parentId: string | null): NodeStub[] =>
    (index.tree.childrenByParentId.get(parentId) ?? []).filter((node) => !isChapterSummary(node));
  const roots = lineChildren(null);
  const { visuals, sketchWords } = createVisualTree({
    roots, lineChildren, activeIds, activeLeafId,
    sketchNodeIds: index.mapSketchNodeIds, showSketches: options.showSketches === true
  });
  const words = cumulativeWords(payload.nodes);
  const drawn = drawGraph(visuals, index.depthByNodeId, activeIds, words, index.tagByNodeId, options.now);
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
  massLines.sort((left, right) => {
    if (sort === "size") return right.words - left.words;
    if (sort === "recency") return Date.parse(right.node.lastTouched) - Date.parse(left.node.lastTouched);
    if (sort === "depth") return right.depth - left.depth || right.words - left.words;
    return massName(left).localeCompare(massName(right));
  });
  const sortedRows = [...massLines.map((row) => row.id === massActiveId ? { ...row, active: true } : row),
    ...drawn.filter((row) => row.kind === "sketch")];

  const windowed = windowRows(sortedRows, {
    wanted: options.cursorId ?? massActiveId, home: massActiveId,
    selectable: selectableRow, maxRows: options.maxRows
  });
  // Mass reads `stale` as ink (doc 26a sinks a cold line's bar) and never
  // folds, so this is the only cold-related repaint the mass view schedules —
  // the moment a visible line crosses the threshold, or it would stay bright
  // until an unrelated keypress redrew it. The line you are on is exempt: it
  // keeps the lantern either way.
  for (const row of windowed.rows) {
    if (row.stale || row.active) continue;
    const touched = Date.parse(row.node.lastTouched);
    if (Number.isFinite(touched)) options.deadlines?.at(touched + (COLD_DAYS + 1) * DAY);
  }
  const lineNodes = payload.nodes.filter((node) => !isChapterSummary(node));
  return {
    rows: windowed.rows, allRows: windowed.allRows, cursorId: windowed.cursorId, sort,
    totalLines: index.mapLineCount,
    totalParts: lineNodes.length,
    forkCount: lineNodes.filter((node) => node.childCount >= 2).length + Number(roots.length > 1),
    // What the story actually holds. Summing each line's *cumulative* words
    // counts the shared trunk once per line, which is what made the old mass
    // header claim roughly three times the prose that had been written (26a).
    storyWords: lineNodes.reduce((sum, node) => sum + node.words, 0),
    sketchCount: index.mapSketchNodeIds.size, sketchWords,
    massMaximum,
    moreRows: windowed.moreRows,
    visibleStart: windowed.visibleStart, visibleEnd: windowed.visibleEnd, totalRows: windowed.totalRows
  };
}

interface VisualTreeOptions {
  roots: readonly NodeStub[];
  lineChildren: (parentId: string | null) => NodeStub[];
  activeIds: ReadonlySet<string>;
  activeLeafId: string | null;
  sketchNodeIds: ReadonlySet<string>;
  showSketches: boolean;
}

function createVisualTree(options: VisualTreeOptions): {
  visuals: VisualNode[]; sketchWords: number;
} {
  const visuals: VisualNode[] = [];
  let sketchWords = 0;
  // Explicit work stack: story depth is user data and may exceed the JS call stack.
  const stack: ClassifyFrame[] = [{ nodes: options.roots, target: visuals }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    // Copy before sorting so the shared story index remains immutable. The sort
    // is stable: the active continuation leads, all other sibling order stays.
    const ordered = [...frame.nodes].sort((left, right) =>
      Number(options.activeIds.has(right.id)) - Number(options.activeIds.has(left.id)));
    for (const anchor of ordered) {
      if (options.sketchNodeIds.has(anchor.id)) {
        // A sketch is a childless take, so its own words are its whole weight.
        sketchWords += anchor.words;
        if (options.showSketches) frame.target.push({ kind: "sketch", node: anchor });
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
        value: { anchor, end, children, activeEnd: end.id === options.activeLeafId }
      });
      if (structuralChildren.length > 0) {
        stack.push({ nodes: structuralChildren, target: children });
      }
    }
    frame.target.sort((left, right) => Number(left.kind === "sketch") - Number(right.kind === "sketch"));
  }
  return { visuals, sketchWords };
}

/** Which rows the cursor may land on. Shared so placement and movement cannot
 *  drift — a cursor parked where the down arrow can never reach it is unrecoverable. */
export function selectableRow(row: AtlasRow): boolean {
  return row.kind === "sketch" || (row.kind === "node" && row.lineEnd);
}
/** A logical line for the mass view: a line end that does not carry on below. */
function isMassLine(row: AtlasRow): boolean {
  return row.kind === "node" && row.lineEnd && !row.continuesBelow;
}

export function moveAtlasCursor(layout: AtlasLayout, direction: -1 | 1): string | null {
  const rows = layout.allRows.filter(selectableRow);
  if (rows.length === 0) return null;
  const at = Math.max(0, rows.findIndex((row) => row.cursor));
  return rows[Math.max(0, Math.min(rows.length - 1, at + direction))]!.id;
}

/** The trunk is the current reading line, pinned at column 0. Every other line
 *  hangs off it as a single collapsed stub, so the walk stays two columns wide
 *  instead of one rail per line (spec §4). Doc "10a" moved the tree itself onto
 *  `lane-layout.ts`; this walk survives only because the mass view still reads
 *  `continuesBelow`/`branch` off its row order to find `massActiveId`. */
function drawGraph(
  visuals: VisualNode[], depths: ReadonlyMap<string, number>,
  active: ReadonlySet<string>, words: ReadonlyMap<string, number>,
  tags: ReadonlyMap<string, Tag>, now: number
): AtlasRow[] {
  const state: DrawState = { rows: [], depths, active, words, tags, now };
  const trunkRoot = visuals.find(
    (visual): visual is Extract<VisualNode, { kind: "segment" }> =>
      visual.kind === "segment" && active.has(visual.value.anchor.id)
  ) ?? null;
  // A story with no reading line, or extra root lines beside it, has no fork to
  // hang those lines from — they lead as top-level stubs above the trunk.
  drawBranchGroup(visuals.filter((visual) => visual !== trunkRoot), state);
  drawTrunk(trunkRoot, state);
  return state.rows;
}

function drawTrunk(root: Extract<VisualNode, { kind: "segment" }> | null, state: DrawState): void {
  let seg: Extract<VisualNode, { kind: "segment" }> | null = root;
  let isRoot = true;
  // The walk descends one segment per iteration, so a deep line never recurses.
  while (seg !== null) {
    const { anchor, end, children, activeEnd } = seg.value;
    // The trunk continuation is the reading line's own next segment; a stop
    // (`activeEnd`) keeps the first child on the trunk so the line reads on.
    const cont = children[0]?.kind === "segment" ? children[0] : null;
    const branches = cont === null ? children : children.slice(1);
    if (isRoot) pushRow(state, "node", anchor, {
      lineEnd: anchor.id === end.id && (children.length === 0 || activeEnd),
      continuesBelow: anchor.id === end.id && activeEnd && cont !== null
    });
    if (!isRoot || anchor.id !== end.id) pushRow(state, "node", end, {
      lineEnd: children.length === 0 || activeEnd,
      continuesBelow: activeEnd && cont !== null
    });
    drawBranchGroup(branches, state);
    seg = cont;
    isRoot = false;
  }
}

interface BranchEntry { kind: "node" | "sketch"; node: NodeStub }

/** Flatten every non-trunk branch to one row per line, then emit them together
 *  under the shared fork. Sub-forks inside a branch collapse into their own
 *  lines rather than opening rails of their own. */
function drawBranchGroup(branches: readonly VisualNode[], state: DrawState): void {
  for (const entry of collapseBranches(branches)) {
    pushRow(state, entry.kind, entry.node, {
      branch: true, lineEnd: entry.kind === "node",
      fragment: entry.kind === "sketch" ? `“${opening(entry.node.preview)}‥”` : null
    });
  }
}

function collapseBranches(branches: readonly VisualNode[]): BranchEntry[] {
  const entries: BranchEntry[] = [];
  const stack: VisualNode[] = [...branches].reverse();
  while (stack.length > 0) {
    const visual = stack.pop()!;
    if (visual.kind === "sketch") {
      entries.push({ kind: "sketch", node: visual.node });
    } else {
      const children = visual.value.children;
      // The incoming line ends here only when nothing carries it on — a segment
      // continues it, so the endpoint is a line of its own only when every
      // child is a lone take (sketch), or there are none. Those sketches then
      // hang below it once `a` reveals them, and must not replace it.
      if (children.every((child) => child.kind === "sketch")) {
        entries.push({ kind: "node", node: visual.value.end });
      }
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
    }
  }
  return entries;
}

function pushRow(state: DrawState, kind: AtlasRowKind, node: NodeStub, extra: Partial<AtlasRow>): void {
  state.rows.push({
    kind, id: node.id,
    node, depth: state.depths.get(node.id) ?? 0, fragment: null,
    active: state.active.has(node.id), cursor: false, tag: state.tags.get(node.id) ?? null,
    words: state.words.get(node.id) ?? node.words, ownWords: node.words,
    stale: ageDays(node.lastTouched, state.now) > COLD_DAYS,
    branch: false, lineEnd: false, continuesBelow: false, ...extra
  });
}
/** The by-name sort key is the label the reader sees. Reimplementing the date
 *  format here would let unnamed lines order by something not on screen. */
function massName(row: AtlasRow): string {
  return row.tag?.name ?? `unnamed · ${shortDate(row.node.lastTouched)}`;
}
export function shortDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return `${date.getUTCDate()} ${["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][date.getUTCMonth()]}`;
}
