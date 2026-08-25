import { createStoryIndex } from "../../shared/story-model.js";
import { isChapterSummary } from "../../shared/story-tree.js";
import type { Tag, NodeStub, StoryPayload } from "../../shared/types.js";
import { ageDays, cumulativeWords, COLD_DAYS, DAY } from "./atlas-layout.js";
import type { FrameDeadlineCollector } from "./animation-deadline.js";
import { assignLanes, padAlive, LANE_BUDGET, type RawItem } from "./lane-layout-assign.js";

export { LANE_BUDGET };

/** Doc "10a": rows are reading order, each live story line owns a two-column
 *  lane, and a line that ends hands its lane back for the next fork to reuse.
 *  Depth costs nothing; only concurrency does. */

interface LaneRowBase {
  /** Story depth (¶ number) the row sits at; fork and close rows carry the depth they follow. */
  depth: number;
  /** Lane index; -1 when the line is parked in the overflow column. Lane 0 is the reading line. */
  lane: number;
  /** Lanes drawn as `│` on this row (index = lane), before this row's own effect. */
  alive: readonly boolean[];
  /** Parked (overflow) lines alive at this row. */
  parked: number;
  cursor: boolean;
}
export type LaneRow = LaneRowBase & (
  | { kind: "node"; id: string; node: NodeStub; active: boolean; tag: Tag | null }
  | { kind: "end"; id: string; node: NodeStub; tag: Tag | null; words: number }
  | { kind: "sketch"; id: string; node: NodeStub }
  | { kind: "sketches"; id: string; forkId: string; count: number }
  | { kind: "cold"; id: string; node: NodeStub; lineCount: number; weeks: number }
  | { kind: "fork"; id: string; node: NodeStub; toLanes: readonly number[]; parkedCount: number }
  | { kind: "close"; id: string; lanes: readonly number[] }
);

export interface LaneLayout {
  rows: LaneRow[];
  allRows: LaneRow[];
  cursorId: string | null;
  /** Max lanes ever alive across the whole story (≥ 1), capped at LANE_BUDGET. */
  laneCount: number;
  /** Whether any line is parked anywhere in the story (draws the overflow column on every row). */
  overflow: boolean;
  totalLines: number; totalParts: number; forkCount: number;
  coldLines: number; coldSubtrees: number; sketchCount: number;
  visibleStart: number; visibleEnd: number; totalRows: number; moreRows: number;
}
export interface LaneLayoutOptions {
  now: number; cursorId?: string | null; showSketches?: boolean;
  openedColdFolds?: ReadonlySet<string>; maxRows?: number; deadlines?: FrameDeadlineCollector;
}

interface ColdEntry { node: NodeStub; lineCount: number; weeks: number }

interface PendingChild {
  kind: "line" | "cold" | "sketchLane";
  startNode?: NodeStub;
  coldEntry?: ColdEntry;
  sketches?: NodeStub[];
}

interface ChainTask {
  chainId: string; chainRank: number; insideOpened: boolean;
  kind: "line" | "cold" | "sketchLane";
  startNode?: NodeStub;
  coldEntry?: ColdEntry;
  forkNodeId?: string; sketches?: NodeStub[]; forkDepth?: number;
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
  const totals = { coldLines: 0, coldSubtrees: 0 };
  const stack: ChainTask[] = [];

  function classify(node: NodeStub, open: boolean): { sketches: NodeStub[]; colds: ColdEntry[]; lines: NodeStub[] } {
    return classifyList(childrenOf(node.id), open);
  }

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
      // `insideOpened || opened.has(anchor.id)`, checked per child here since
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

  function pendingChildren(lines: NodeStub[], colds: ColdEntry[], sketches: NodeStub[]): PendingChild[] {
    const out: PendingChild[] = lines.map((startNode) => ({ kind: "line" as const, startNode }));
    for (const coldEntry of colds) out.push({ kind: "cold", coldEntry });
    if (sketches.length > 0) out.push({ kind: "sketchLane", sketches });
    return out;
  }

  /** Opens the fork row (if there is anything to fork) and pushes each new
   *  chain onto the work stack. Chain rank is assigned here, in fork order,
   *  so the sort's tiebreaker matches a trunk-first depth-first walk. */
  function openFork(
    node: NodeStub, depth: number, chainId: string, chainRank: number,
    children: PendingChild[], insideOpened: boolean, forkId = `${node.id}:fork`
  ): void {
    if (children.length === 0) return;
    const childChainIds: string[] = [];
    for (const child of children) {
      const id = `${forkId}:${childChainIds.length}`;
      const rank = nextRank();
      childChainIds.push(id);
      if (child.kind === "line") {
        stack.push({ chainId: id, chainRank: rank, insideOpened, kind: "line", startNode: child.startNode! });
      } else if (child.kind === "cold") {
        stack.push({ chainId: id, chainRank: rank, insideOpened, kind: "cold", coldEntry: child.coldEntry! });
      } else {
        stack.push({
          chainId: id, chainRank: rank, insideOpened, kind: "sketchLane",
          forkNodeId: node.id, sketches: child.sketches!, forkDepth: depth
        });
      }
    }
    items.push({ itemKind: "fork", depth, order: 2, chainId, chainRank, node, childChainIds, forkId });
  }

  function pushCold(chainId: string, chainRank: number, coldEntry: ColdEntry): void {
    const depth = depthOf(coldEntry.node);
    totals.coldLines += coldEntry.lineCount;
    totals.coldSubtrees += 1;
    items.push({
      itemKind: "draw", depth, order: 0, chainId, chainRank,
      build: (lane, alive, parked) => ({
        kind: "cold", id: coldEntry.node.id, node: coldEntry.node,
        lineCount: coldEntry.lineCount, weeks: coldEntry.weeks,
        depth, lane, alive, parked, cursor: false
      })
    });
    items.push({ itemKind: "close", depth, order: 1, chainId, chainRank });
  }

  function pushSketches(
    chainId: string, chainRank: number, forkId: string, sketches: readonly NodeStub[], fallbackDepth: number
  ): number {
    const depth = sketches.length > 0 ? depthOf(sketches[0]!) : fallbackDepth;
    if (showSketches) {
      for (const sketch of sketches) {
        items.push({
          itemKind: "draw", depth, order: 0, chainId, chainRank,
          build: (lane, alive, parked) => ({
            kind: "sketch", id: sketch.id, node: sketch, depth, lane, alive, parked, cursor: false
          })
        });
      }
    } else {
      const count = sketches.length;
      items.push({
        itemKind: "draw", depth, order: 0, chainId, chainRank,
        build: (lane, alive, parked) => ({
          kind: "sketches", id: `${forkId}:sketches`, forkId, count,
          depth, lane, alive, parked, cursor: false
        })
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
      openFork(trunkRoot, 0, "trunk", 0, pendingChildren(lines, colds, sketches), false, "virtual-root:fork");
    }
    let node = trunkRoot;
    let pathIndex = 0;
    for (;;) {
      // A fresh binding per iteration: `build` runs later, once lanes are
      // assigned, and must not read whatever `node` holds by then — the loop
      // keeps reassigning it (a captured `let` would read the trunk's last node).
      const trunkNode = node;
      const depth = depthOf(trunkNode);
      const active = trunkNode.id === activeLeafId;
      const tag = tagOf(trunkNode.id);
      items.push({
        itemKind: "draw", depth, order: 0, chainId: "trunk", chainRank: 0,
        build: (lane, alive, parked) => ({
          kind: "node", id: trunkNode.id, node: trunkNode, active, tag, depth, lane, alive, parked, cursor: false
        })
      });
      const { sketches, colds, lines } = classify(node, false);
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
        openFork(node, depth, "trunk", 0, pendingChildren(lines, colds, sketches), false);
      }
      if (coldCont !== null) {
        const coldDepth = depthOf(coldCont.node);
        totals.coldLines += coldCont.lineCount;
        totals.coldSubtrees += 1;
        items.push({
          itemKind: "draw", depth: coldDepth, order: 0, chainId: "trunk", chainRank: 0,
          build: (lane, alive, parked) => ({
            kind: "cold", id: coldCont.node.id, node: coldCont.node,
            lineCount: coldCont.lineCount, weeks: coldCont.weeks,
            depth: coldDepth, lane, alive, parked, cursor: false
          })
        });
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
      const { sketches, colds, lines } = classify(node, open);
      const cont = lines.length > 0 ? lines.shift()! : null;
      const coldCont = cont === null && colds.length > 0 ? colds.shift()! : null;
      const isEnd = cont === null && coldCont === null;
      if (!isEnd) openFork(node, depthOf(node), chainId, chainRank, pendingChildren(lines, colds, sketches), open);
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
          build: (lane, alive, parked) => ({
            kind: "end", id: node.id, node, tag, words, depth, lane, alive, parked, cursor: false
          })
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
    if (task.kind === "line") walkLineChain(task.chainId, task.chainRank, task.startNode!, task.insideOpened);
    else if (task.kind === "cold") pushCold(task.chainId, task.chainRank, task.coldEntry!);
    else {
      const depth = pushSketches(task.chainId, task.chainRank, task.forkNodeId!, task.sketches!, task.forkDepth! + 1);
      items.push({ itemKind: "close", depth, order: 1, chainId: task.chainId, chainRank: task.chainRank });
    }
  }

  const sorted = [...items].sort((left, right) =>
    left.depth - right.depth || left.order - right.order || left.chainRank - right.chainRank);
  const { rows: allRowsRaw, laneCount, overflow } = assignLanes(sorted);

  const selectable = (row: LaneRow): boolean => laneSelectable(row);
  const wanted = options.cursorId ?? activeLeafId;
  const cursorId = allRowsRaw.some((row) => selectable(row) && row.id === wanted)
    ? wanted
    : allRowsRaw.find((row) => selectable(row) && row.id === activeLeafId)?.id
      ?? allRowsRaw.find(selectable)?.id ?? null;
  const allRows = allRowsRaw.map((row) => ({
    ...row, alive: padAlive(row.alive, laneCount), cursor: selectable(row) && row.id === cursorId
  }));

  const maxRows = Math.max(1, options.maxRows ?? (allRows.length || 1));
  const cursorIndex = Math.max(0, allRows.findIndex((row) => row.cursor));
  const visibleStart = Number.isFinite(maxRows)
    ? Math.max(0, Math.min(cursorIndex - Math.floor(maxRows / 2), allRows.length - maxRows)) : 0;
  const rows = allRows.slice(visibleStart, Number.isFinite(maxRows) ? visibleStart + maxRows : undefined);
  for (const row of rows) {
    if (row.kind !== "cold") continue;
    const touched = Date.parse(row.node.lastTouched);
    if (Number.isFinite(touched)) deadlines?.at(touched + (row.weeks + 1) * 7 * DAY);
  }

  const lineNodes = payload.nodes.filter((node) => !isChapterSummary(node));
  const roots = childrenOf(null);
  return {
    rows, allRows, cursorId, laneCount, overflow,
    totalLines: index.mapLineCount,
    totalParts: lineNodes.length,
    forkCount: lineNodes.filter((node) => node.childCount >= 2).length + Number(roots.length > 1),
    coldLines: totals.coldLines, coldSubtrees: totals.coldSubtrees,
    sketchCount: index.mapSketchNodeIds.size,
    visibleStart, visibleEnd: visibleStart + rows.length, totalRows: allRows.length,
    moreRows: Math.max(0, allRows.length - visibleStart - rows.length)
  };
}

/** Which rows the cursor may land on: node, end, sketch, cold. A `sketches`
 *  fold answers to `toggle-sketches`, never the cursor (spec §3, `map-lane-body.ts`). */
export function laneSelectable(row: LaneRow): boolean {
  return row.kind === "node" || row.kind === "end" || row.kind === "sketch" || row.kind === "cold";
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
