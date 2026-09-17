/** D-34 fisheye lens: pure helpers shared by `renderer-map-layout.ts` (which
 * decides what the lens opens, as part of `computeMapLayout`) and
 * `renderer-map-view.ts` (which draws the result). Split into its own file
 * for the same reason `renderer-minimap-layout.ts` (D-35) is one — it keeps
 * `renderer-map-layout.ts` under the repo's ~500-line guideline. */
import type { NodeStub } from "../shared/types.js";

/** Primitives reserved out of `maxNodes` for the lens to open branches with,
 * held back before windowing picks `[lo, hi)` so a windowed story still has
 * room to open runs once a lens lands inside it. */
export const LENS_BUDGET = 32;
/** The lens starts at `lensIndex ± 1` and never grows past `lensIndex ± 4`. */
export const LENS_MAX_RADIUS = 4;
/** Horizontal spacing between consecutive nodes of an opened chain. */
export const LENS_CHAIN_GAP = 20;
/** Gap from an opened chain's last node to its "rest of the subtree" bar. */
export const LENS_REST_GAP = 14;
/** Padding around the opened span the lens wash draws. */
export const LENS_PAD = 16;

/** D-34: the dashed wash the view draws under the nodes, and the spine span
 * it opened runs across. `[startIndex, endIndex]` is inclusive. */
export interface MapLensLayout {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly x: number;
  readonly width: number;
}

/** D-34: the chain an opened branch draws — from its root down to a leaf,
 * following `activeChildId` when it names a child, else the most recently
 * touched child (the reading a writer last looked at on that branch). Stops
 * at the first node with no children; a `seen` guard stops a corrupt or
 * cyclic `activeChildId` from looping forever. */
export function walkActiveChain(branchRoot: NodeStub, childrenByParent: ReadonlyMap<string | null, readonly NodeStub[]>): NodeStub[] {
  const chain: NodeStub[] = [branchRoot];
  const seen = new Set([branchRoot.id]);
  let current = branchRoot;
  for (;;) {
    const kids = childrenByParent.get(current.id) ?? [];
    if (kids.length === 0) break;
    const active = current.activeChildId === null ? undefined : kids.find((kid) => kid.id === current.activeChildId);
    const next = active ?? kids.reduce((best, kid) => (Date.parse(kid.lastTouched) > Date.parse(best.lastTouched) ? kid : best), kids[0]!);
    if (seen.has(next.id)) break;
    seen.add(next.id);
    chain.push(next);
    current = next;
  }
  return chain;
}
