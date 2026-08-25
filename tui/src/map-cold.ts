import type { NodeStub } from "../../shared/types.js";

/** Shared by `lane-layout.ts` and `atlas-layout.ts` — neither is the other's
 *  dependency for this. `cumulativeWords` is not itself about age, but it has
 *  no better neutral home than the module the two layouts already share for
 *  age math, so it rides along here rather than forcing a third shared module
 *  for one function. */
export const DAY = 86_400_000;
export const COLD_DAYS = 21;

export function ageDays(value: string, now: number): number {
  const touched = Date.parse(value);
  return Number.isFinite(touched) ? Math.floor(Math.max(0, now - touched) / DAY) : 0;
}

/** An `end` row's (or a mass row's) word count must read the same number
 *  every view gives a line — words from the root, not just words along the
 *  segment that happens to be off-path. */
export function cumulativeWords(nodes: readonly NodeStub[]): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const node of nodes) totals.set(node.id, (node.parentId === null ? 0 : totals.get(node.parentId) ?? 0) + node.words);
  return totals;
}
