import type { LaneRow } from "./lane-layout.js";
import type { NodeStub } from "../../shared/types.js";

/** Doc "10e"'s safety net: a story that never abandons a line still gets a
 *  fixed-width gutter. Defined here (not `lane-layout.ts`) so this module,
 *  the lane allocator, never has to import a value back out of the module
 *  that imports it — types only cross that direction. */
export const LANE_BUDGET = 6;

/** A raw layout item before lanes are assigned. Built by a trunk-first
 *  walk of the story (`lane-layout.ts`); sorted by (depth, order, chainRank)
 *  and consumed by `assignLanes`, the single left-to-right pass that turns
 *  them into `LaneRow`s. */
export type RawItem =
  | { itemKind: "draw"; depth: number; order: 0; chainId: string; chainRank: number;
      build: (lane: number, alive: readonly boolean[], parked: number) => LaneRow }
  | { itemKind: "fork"; depth: number; order: 2; chainId: string; chainRank: number;
      node: NodeStub; childChainIds: string[]; forkId: string }
  | { itemKind: "close"; depth: number; order: 1; chainId: string; chainRank: number };

export function padAlive(alive: readonly boolean[], laneCount: number): readonly boolean[] {
  if (alive.length >= laneCount) return alive;
  return [...alive, ...Array<boolean>(laneCount - alive.length).fill(false)];
}

/** The single left-to-right pass over the sorted items: allocates lanes on
 *  each fork (never left of the forking chain's own lane, per doc "10a" —
 *  forks always run rightward), frees them on close, and snapshots `alive`
 *  and `parked` before each row's own effect. Consecutive close items merge
 *  into one row (the mock's `│ ╵ ╵`). */
export function assignLanes(sorted: readonly RawItem[]): { rows: LaneRow[]; laneCount: number; overflow: boolean } {
  const lanes: Array<string | null> = ["trunk"];
  const chainLane = new Map<string, number>([["trunk", 0]]);
  const rows: LaneRow[] = [];
  let parkedCount = 0;
  let maxLaneIndex = 0;
  let overflow = false;
  let pendingCloseLanes: number[] = [];
  let pendingCloseAlive: readonly boolean[] | null = null;
  let pendingCloseParked = 0;
  let pendingCloseDepth = 0;

  const flushCloses = () => {
    if (pendingCloseLanes.length === 0) return;
    const lanesClosing = pendingCloseLanes;
    rows.push({
      kind: "close", id: `close:${pendingCloseDepth}:${lanesClosing.join(",")}`, lanes: lanesClosing,
      depth: pendingCloseDepth, lane: lanesClosing[0]!, alive: pendingCloseAlive ?? [],
      parked: pendingCloseParked, cursor: false
    });
    pendingCloseLanes = [];
    pendingCloseAlive = null;
  };

  for (const [index, item] of sorted.entries()) {
    if (item.itemKind === "close") {
      if (pendingCloseLanes.length === 0) {
        pendingCloseAlive = lanes.map((slot) => slot !== null);
        pendingCloseParked = parkedCount;
        pendingCloseDepth = item.depth;
      }
      const laneIndex = chainLane.get(item.chainId);
      if (laneIndex === -1) parkedCount -= 1;
      else if (laneIndex !== undefined) { lanes[laneIndex] = null; pendingCloseLanes.push(laneIndex); }
      chainLane.delete(item.chainId);
      const next = sorted[index + 1];
      if (next === undefined || next.itemKind !== "close") flushCloses();
      continue;
    }
    if (item.itemKind === "fork") {
      const ownLane = chainLane.get(item.chainId) ?? -1;
      const alive = lanes.map((slot) => slot !== null);
      const parkedBefore = parkedCount;
      const toLanes: number[] = [];
      let parkedHere = 0;
      for (const childId of item.childChainIds) {
        // A parked chain (ownLane -1) has no column of its own to fork
        // rightward from, so every child it forks parks too (doc "10e": "a
        // fork that can't reach a drawn lane goes straight into ⋯").
        let target: number | null = null;
        if (ownLane !== -1) {
          for (let i = ownLane + 1; i < LANE_BUDGET; i += 1) {
            if (i >= lanes.length || lanes[i] === null) { target = i; break; }
          }
        }
        if (target === null) {
          chainLane.set(childId, -1);
          parkedCount += 1;
          parkedHere += 1;
          overflow = true;
        } else {
          while (lanes.length <= target) lanes.push(null);
          lanes[target] = childId;
          chainLane.set(childId, target);
          toLanes.push(target);
          maxLaneIndex = Math.max(maxLaneIndex, target);
        }
      }
      rows.push({
        kind: "fork", id: item.forkId, node: item.node, toLanes, parkedCount: parkedHere,
        depth: item.depth, lane: ownLane, alive, parked: parkedBefore, cursor: false
      });
      continue;
    }
    const lane = chainLane.get(item.chainId) ?? -1;
    const alive = lanes.map((slot) => slot !== null);
    rows.push(item.build(lane, alive, parkedCount));
  }
  flushCloses();
  return { rows, laneCount: Math.min(LANE_BUDGET, maxLaneIndex + 1), overflow };
}
