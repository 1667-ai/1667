import { createStoryIndex } from "../../shared/story-model.js";
import { isChapterSummary } from "../../shared/story-tree.js";
import type { Tag, NodeStub, StoryPayload } from "../../shared/types.js";
import { ageDays, cumulativeWords, COLD_DAYS, DAY } from "./map-cold.js";
import type { FrameDeadlineCollector } from "./animation-deadline.js";
import { assignLanes, type LaneRow, type RawItem } from "./lane-layout-assign.js";
import { windowRows } from "./map-window.js";

export { LANE_BUDGET } from "./lane-layout-assign.js";
export type { LaneRow, LaneRowBase } from "./lane-layout-assign.js";

/** Doc "10a": rows are reading order, each live story line owns a two-column
 *  lane, and a line that ends hands its lane back for the next fork to reuse.
 *  Depth costs nothing; only concurrency does. */

export interface LaneLayout {
  rows: LaneRow[];
  allRows: LaneRow[];
  cursorId: string | null;
  /** Max lanes ever alive across the whole story (≥ 1), capped at LANE_BUDGET. */
  laneCount: number;
  /** Whether any line is parked anywhere in the story (draws the overflow column on every row). */
  overflow: boolean;
  totalLines: number; totalParts: number; forkCount: number;
  coldLines: number;
  visibleStart: number; visibleEnd: number; totalRows: number; moreRows: number;
}
export interface LaneLayoutOptions {
  now: number; cursorId?: string | null; showSketches?: boolean;
  openedColdFolds?: ReadonlySet<string>; maxRows?: number; deadlines?: FrameDeadlineCollector;
}

interface ColdEntry { node: NodeStub; lineCount: number; weeks: number }

/** What a chain starts on, once its own continuation has already been picked
 *  out of its siblings: an ordinary line, a subtree already past the cold
 *  threshold, or the fork's one combined sketches lane. */
type ChainStart =
  | { kind: "line"; node: NodeStub }
  | { kind: "cold"; entry: ColdEntry }
  | { kind: "sketches"; forkNodeId: string; sketches: NodeStub[]; forkDepth: number };

interface ChainTask {
  chainId: string; chainRank: number; insideOpened: boolean; start: ChainStart;
}

export function createLaneLayout(payload: StoryPayload, options: LaneLayoutOptions): LaneLayout {
  const index = createStoryIndex(payload);
  const activeIds = new Set(payload.path.map((node) => node.id));
  const activeLeafId = payload.path.at(-1)?.id ?? null;
  const opened = options.openedColdFolds ?? new Set<string>();
  const showSketches = options.showSketches === true;
  const now = options.now;
  const deadlines = options.deadlines;
  const childrenOf = (parentId: string | null): NodeStub[] =>
    (index.tree.childrenByParentId.get(parentId) ?? []).filter((node) => !isChapterSummary(node));
  const depthOf = (node: NodeStub): number => index.depthByNodeId.get(node.id) ?? 0;
  const tagOf = (nodeId: string): Tag | null => index.tagByNodeId.get(nodeId) ?? null;
  const rootWords = cumulativeWords(payload.nodes);

  const items: RawItem[] = [];
  let rankCounter = 0;
  const nextRank = (): number => (rankCounter += 1) - 1;
  const totals = { coldLines: 0 };
  const stack: ChainTask[] = [];

  /** Shared by a real node's children and the story's extra root lines, which
   *  have no parent node to hang a `childrenOf` lookup off — the virtual-root
   *  fork classifies them exactly like any other fork's children. */
  function classifyList(candidates: readonly NodeStub[], open: boolean): { sketches: NodeStub[]; colds: ColdEntry[]; lines: NodeStub[] } {
    const sketches: NodeStub[] = [];
    const colds: ColdEntry[] = [];
    const lines: NodeStub[] = [];
    for (const child of candidates) {
      if (index.mapSketchNodeIds.has(child.id)) { sketches.push(child); continue; }
      // `open` is inherited from an ancestor already inside an opened fold;
      // `opened.has(child.id)` is this child's own fold having just been
      // opened. Either one means nothing below it folds (mirrors atlas-layout's
      // old `insideOpened || opened.has(anchor.id)`, checked per child here since
      // a shared `open` would give every sibling the same fold state.
      const childOpen = open || opened.has(child.id);
      const days = ageDays(child.lastTouched, now);
      const touched = Date.parse(child.lastTouched);
      const canFoldCold = !childOpen && !activeIds.has(child.id) && Number.isFinite(touched);
      if (canFoldCold && days <= COLD_DAYS) deadlines?.at(touched + (COLD_DAYS + 1) * DAY);
      if (canFoldCold && days > COLD_DAYS) {
        const lineCount = index.mapLineCountByNodeId.get(child.id) ?? child.leafCount;
        colds.push({ node: child, lineCount, weeks: Math.floor(days / 7) });
        continue;
      }
      lines.push(child);
    }
    return { sketches, colds, lines };
  }

  /** The `lines`/`colds`/`sketches` a fork still has left, once any of them
   *  that continues the current chain has already been shifted out, as one
   *  `ChainStart[]` in the order doc "10a" forks them: lines, then colds,
   *  then one combined sketches lane. */
  function chainStarts(
    lines: NodeStub[], colds: ColdEntry[], sketches: NodeStub[], forkNodeId: string, forkDepth: number
  ): ChainStart[] {
    const starts: ChainStart[] = lines.map((node) => ({ kind: "line" as const, node }));
    for (const entry of colds) starts.push({ kind: "cold", entry });
    if (sketches.length > 0) starts.push({ kind: "sketches", forkNodeId, sketches, forkDepth });
    return starts;
  }

  /** Opens the fork row (if there is anything to fork) and pushes each new
   *  chain onto the work stack. Chain rank is assigned here, in fork order, so
   *  the sort's tiebreaker matches a trunk-first depth-first walk — which
   *  needs the *push* to run in reverse: the stack is LIFO, so pushing the
   *  first sibling last is what makes it pop (and so rank its own nested
   *  forks) first. */
  function openFork(
    node: NodeStub, depth: number, chainId: string, chainRank: number,
    starts: ChainStart[], insideOpened: boolean, forkId = `${node.id}:fork`
  ): void {
    if (starts.length === 0) return;
    const childChainIds: string[] = [];
    const tasks: ChainTask[] = [];
    for (const start of starts) {
      const id = `${forkId}:${childChainIds.length}`;
      const rank = nextRank();
      childChainIds.push(id);
      tasks.push({ chainId: id, chainRank: rank, insideOpened, start });
    }
    for (let i = tasks.length - 1; i >= 0; i -= 1) stack.push(tasks[i]!);
    items.push({ itemKind: "fork", depth, order: 2, chainId, chainRank, childChainIds, forkId });
  }

  function coldRow(chainId: string, chainRank: number, entry: ColdEntry): RawItem {
    const depth = depthOf(entry.node);
    totals.coldLines += entry.lineCount;
    return {
      itemKind: "draw", depth, order: 0, chainId, chainRank,
      row: { kind: "cold", id: entry.node.id, node: entry.node, lineCount: entry.lineCount, weeks: entry.weeks, depth }
    };
  }

  function pushCold(chainId: string, chainRank: number, entry: ColdEntry): void {
    items.push(coldRow(chainId, chainRank, entry));
    items.push({ itemKind: "close", depth: depthOf(entry.node), order: 1, chainId, chainRank });
  }

  function pushSketches(
    chainId: string, chainRank: number, forkId: string, sketches: readonly NodeStub[], fallbackDepth: number
  ): number {
    const depth = sketches.length > 0 ? depthOf(sketches[0]!) : fallbackDepth;
    if (showSketches) {
      for (const sketch of sketches) {
        items.push({
          itemKind: "draw", depth, order: 0, chainId, chainRank,
          row: { kind: "sketch", id: sketch.id, node: sketch, depth }
        });
      }
    } else {
      const count = sketches.length;
      items.push({
        itemKind: "draw", depth, order: 0, chainId, chainRank,
        row: { kind: "sketches", id: `${forkId}:sketches`, forkId, count, depth }
      });
    }
    return depth;
  }

  function walkTrunk(): void {
    const pathNodes = payload.path
      .map((node) => index.tree.nodesById.get(node.id))
      .filter((node): node is NodeStub => node !== undefined);
    if (pathNodes.length === 0) return;
    const trunkRoot = pathNodes[0]!;
    // A story with extra root lines beside the reading one has no real node
    // to fork them from, so the walk treats the story itself as a fork at
    // depth 0 whose continuation is the trunk root — one chain per extra
    // root, classified exactly like any other fork's children.
    const otherRoots = childrenOf(null).filter((root) => root.id !== trunkRoot.id);
    if (otherRoots.length > 0) {
      const { sketches, colds, lines } = classifyList(otherRoots, false);
      openFork(trunkRoot, 0, "trunk", 0, chainStarts(lines, colds, sketches, trunkRoot.id, 0), false, "virtual-root:fork");
    }
    let node = trunkRoot;
    let pathIndex = 0;
    // Threaded exactly like an off-path chain's own `open`: once the trunk
    // has read past a node the reader opened, nothing below it refolds — a
    // stopped line that continues into an opened cold subtree must not
    // re-cold its own grandchildren.
    let open = false;
    for (;;) {
      const depth = depthOf(node);
      const active = node.id === activeLeafId;
      const tag = tagOf(node.id);
      items.push({
        itemKind: "draw", depth, order: 0, chainId: "trunk", chainRank: 0,
        row: { kind: "node", id: node.id, node, active, tag, depth }
      });
      open = open || opened.has(node.id);
      const { sketches, colds, lines } = classifyList(childrenOf(node.id), open);
      let cont: NodeStub | null = null;
      if (pathIndex + 1 < pathNodes.length) {
        const next = pathNodes[pathIndex + 1]!;
        cont = next;
        for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i]!.id === next.id) lines.splice(i, 1);
        pathIndex += 1;
      } else if (lines.length > 0) {
        cont = lines.shift()!;
      }
      const coldCont = cont === null && colds.length > 0 ? colds.shift()! : null;
      const isEnd = cont === null && coldCont === null;
      if (!isEnd) {
        openFork(node, depth, "trunk", 0, chainStarts(lines, colds, sketches, node.id, depth), open);
      }
      if (coldCont !== null) {
        // Lane 0 (the trunk) never closes, so the tail cold row has no
        // matching close item — reuse `pushCold`'s row half only.
        items.push(coldRow("trunk", 0, coldCont));
        return;
      }
      if (cont === null) {
        if (sketches.length > 0) pushSketches("trunk", 0, node.id, sketches, depth);
        return;
      }
      node = cont;
    }
  }

  function walkLineChain(chainId: string, chainRank: number, startNode: NodeStub, insideOpened: boolean): void {
    let node = startNode;
    let open = insideOpened;
    for (;;) {
      open = open || opened.has(node.id);
      const { sketches, colds, lines } = classifyList(childrenOf(node.id), open);
      const cont = lines.length > 0 ? lines.shift()! : null;
      const coldCont = cont === null && colds.length > 0 ? colds.shift()! : null;
      const isEnd = cont === null && coldCont === null;
      if (!isEnd) {
        openFork(node, depthOf(node), chainId, chainRank, chainStarts(lines, colds, sketches, node.id, depthOf(node)), open);
      }
      if (coldCont !== null) { pushCold(chainId, chainRank, coldCont); return; }
      if (cont === null) {
        const depth = depthOf(node);
        const tag = tagOf(node.id);
        // Cumulative from the root, same as the mass view's own `ownWords` —
        // a lone off-path node cannot be weighed by itself, or `salt road`
        // would carry a different number in the tree than in mass.
        const words = rootWords.get(node.id) ?? node.words;
        items.push({
          itemKind: "draw", depth, order: 0, chainId, chainRank,
          row: { kind: "end", id: node.id, node, tag, words, depth }
        });
        let lastDepth = depth;
        if (sketches.length > 0) lastDepth = pushSketches(chainId, chainRank, node.id, sketches, depth);
        items.push({ itemKind: "close", depth: lastDepth, order: 1, chainId, chainRank });
        return;
      }
      node = cont;
    }
  }

  walkTrunk();
  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.start.kind === "line") walkLineChain(task.chainId, task.chainRank, task.start.node, task.insideOpened);
    else if (task.start.kind === "cold") pushCold(task.chainId, task.chainRank, task.start.entry);
    else {
      const depth = pushSketches(task.chainId, task.chainRank, task.start.forkNodeId, task.start.sketches, task.start.forkDepth + 1);
      items.push({ itemKind: "close", depth, order: 1, chainId: task.chainId, chainRank: task.chainRank });
    }
  }

  const sorted = [...items].sort((left, right) =>
    left.depth - right.depth || left.order - right.order || left.chainRank - right.chainRank);
  const { rows: allRowsRaw, laneCount, overflow } = assignLanes(sorted);

  const windowed = windowRows(allRowsRaw, {
    wanted: options.cursorId ?? activeLeafId, home: activeLeafId,
    selectable: laneSelectable, maxRows: options.maxRows
  });
  for (const row of windowed.rows) {
    if (row.kind !== "cold") continue;
    const touched = Date.parse(row.node.lastTouched);
    if (Number.isFinite(touched)) deadlines?.at(touched + (row.weeks + 1) * 7 * DAY);
  }

  const lineNodes = payload.nodes.filter((node) => !isChapterSummary(node));
  const roots = childrenOf(null);
  return {
    rows: windowed.rows, allRows: windowed.allRows, cursorId: windowed.cursorId, laneCount, overflow,
    totalLines: index.mapLineCount,
    totalParts: lineNodes.length,
    forkCount: lineNodes.filter((node) => node.childCount >= 2).length + Number(roots.length > 1),
    coldLines: totals.coldLines,
    visibleStart: windowed.visibleStart, visibleEnd: windowed.visibleEnd, totalRows: windowed.totalRows,
    moreRows: windowed.moreRows
  };
}

/** Which rows the cursor may land on: node, end, sketch, cold. A `sketches`
 *  fold answers to `toggle-sketches`, never the cursor (spec §3, `map-lane-body.ts`). */
export function laneSelectable(row: LaneRow): boolean {
  return row.kind === "node" || row.kind === "end" || row.kind === "sketch" || row.kind === "cold";
}

/** Which take a row names: `node`/`end`/`sketch` → its id; a fork, close,
 *  folded sketches count, or cold subtree names no single take. */
export function laneTakeId(row: LaneRow): string | null {
  return row.kind === "node" || row.kind === "end" || row.kind === "sketch" ? row.id : null;
}

/** The `LaneLayoutOptions` every map view derives the same way from its own
 *  interaction state — shared so `map-actions.ts`, `generation-record-actions.ts`,
 *  and `map-lane-body.ts` (which adds `maxRows`/`deadlines` of its own) build
 *  it identically. */
export function laneLayoutOptions(
  state: { now: number },
  map: { treeCursorId: string | null; showSketches: boolean; openedColdFolds: ReadonlySet<string> }
): Pick<LaneLayoutOptions, "now" | "cursorId" | "showSketches" | "openedColdFolds"> {
  return { now: state.now, cursorId: map.treeCursorId, showSketches: map.showSketches, openedColdFolds: map.openedColdFolds };
}

export function moveLaneCursor(layout: LaneLayout, direction: -1 | 1): string | null {
  const rows = layout.allRows.filter(laneSelectable);
  if (rows.length === 0) return null;
  const at = Math.max(0, rows.findIndex((row) => row.cursor));
  return rows[Math.max(0, Math.min(rows.length - 1, at + direction))]!.id;
}

/** The nearest selectable row (by row distance, not depth) one lane to the
 *  left or right of the cursor. A parked row counts as lane `laneCount`, so
 *  `→` from the rightmost drawn lane reaches the overflow column. */
export function moveLaneCursorAcross(layout: LaneLayout, direction: -1 | 1): string | null {
  const rows = layout.allRows;
  const cursorIndex = rows.findIndex((row) => row.cursor);
  if (cursorIndex === -1) return null;
  const cursorRow = rows[cursorIndex]!;
  const cursorLane = cursorRow.lane === -1 ? layout.laneCount : cursorRow.lane;
  const targetLane = cursorLane + direction;
  if (targetLane < 0) return null;
  let best: { id: string; distance: number } | null = null;
  for (const [index, row] of rows.entries()) {
    if (!laneSelectable(row)) continue;
    const rowLane = row.lane === -1 ? layout.laneCount : row.lane;
    if (rowLane !== targetLane) continue;
    const distance = Math.abs(index - cursorIndex);
    if (best === null || distance < best.distance) best = { id: row.id, distance };
  }
  return best?.id ?? null;
}

/** The next selectable row below the cursor still on its own lane — stopping
 *  at the point that lane closes, since a recycled lane number belongs to an
 *  unrelated line past that row (spec §"residual costs"). Falls back to the
 *  cursor's own row: a lane-0 stop, or a terminal off-path row, has nowhere
 *  further to follow. */
export function followLane(layout: LaneLayout): string | null {
  const rows = layout.allRows;
  const at = rows.findIndex((row) => row.cursor);
  if (at === -1) return null;
  const cursorRow = rows[at]!;
  for (let index = at + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === "close" && row.lanes.includes(cursorRow.lane)) return cursorRow.id;
    if (laneSelectable(row) && row.lane === cursorRow.lane) return row.id;
  }
  return cursorRow.id;
}
