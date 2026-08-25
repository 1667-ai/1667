import type { Tag, NodeStub } from "../../shared/types.js";

/** Doc "10e"'s safety net: a story that never abandons a line still gets a
 *  fixed-width gutter. */
export const LANE_BUDGET = 6;

/** Doc "10a": rows are reading order, each live story line owns a two-column
 *  lane, and a line that ends hands its lane back for the next fork to reuse.
 *  Depth costs nothing; only concurrency does. */

export interface LaneRowBase {
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
  | { kind: "fork"; id: string; toLanes: readonly number[]; parkedCount: number }
  | { kind: "close"; id: string; lanes: readonly number[] }
);

/** `Omit` applied to each member of a union separately, so a fork row's body
 *  keeps only its own fields rather than collapsing the union to the fields
 *  every kind shares. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** A `LaneRow` before lane assignment: everything the walk already knows
 *  about the row it is building, minus the four fields only `assignLanes`
 *  can fill in. */
export type LaneRowBody = DistributiveOmit<LaneRow, "lane" | "alive" | "parked" | "cursor">;

/** A raw layout item before lanes are assigned. Built by a trunk-first
 *  walk of the story (`lane-layout.ts`); sorted by (depth, order, chainRank)
 *  and consumed by `assignLanes`, the single left-to-right pass that turns
 *  them into `LaneRow`s. */
export type RawItem =
  | { itemKind: "draw"; depth: number; order: 0; chainId: string; chainRank: number; row: LaneRowBody }
  | { itemKind: "fork"; depth: number; order: 2; chainId: string; chainRank: number;
      childChainIds: string[]; forkId: string }
  | { itemKind: "close"; depth: number; order: 1; chainId: string; chainRank: number };

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
  // A story's whole lane picture never exceeds LANE_BUDGET columns, so every
  // `alive` snapshot is taken at that fixed width up front — nothing downstream
  // has to pad a shorter snapshot out to the story's final lane count.
  const snapshotAlive = (): readonly boolean[] =>
    Array.from({ length: LANE_BUDGET }, (_, lane) => lanes[lane] != null);

  let pending: { lanes: number[]; alive: readonly boolean[]; parked: number; depth: number } | null = null;
  const flushPending = () => {
    if (pending === null) return;
    const { lanes: lanesClosing, alive, parked, depth } = pending;
    rows.push({
      kind: "close", id: `close:${depth}:${lanesClosing.join(",")}`, lanes: lanesClosing,
      depth, lane: lanesClosing[0]!, alive, parked, cursor: false
    });
    pending = null;
  };

  for (const item of sorted) {
    if (item.itemKind === "close") {
      if (pending === null) pending = { lanes: [], alive: snapshotAlive(), parked: parkedCount, depth: item.depth };
      const laneIndex = chainLane.get(item.chainId);
      if (laneIndex === -1) parkedCount -= 1;
      else if (laneIndex !== undefined) { lanes[laneIndex] = null; pending.lanes.push(laneIndex); }
      chainLane.delete(item.chainId);
      continue;
    }
    flushPending();
    if (item.itemKind === "fork") {
      const ownLane = chainLane.get(item.chainId) ?? -1;
      const alive = snapshotAlive();
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
        kind: "fork", id: item.forkId, toLanes, parkedCount: parkedHere,
        depth: item.depth, lane: ownLane, alive, parked: parkedBefore, cursor: false
      });
      continue;
    }
    const lane = chainLane.get(item.chainId) ?? -1;
    const alive = snapshotAlive();
    rows.push({ ...item.row, lane, alive, parked: parkedCount, cursor: false });
  }
  flushPending();
  return { rows, laneCount: Math.min(LANE_BUDGET, maxLaneIndex + 1), overflow };
}
