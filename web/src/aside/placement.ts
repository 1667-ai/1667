import type { StoryNode, StoryPayload } from "../../../shared/types.js";

/**
 * Where an Aside answer can go in the story ("Insert here"): above any part,
 * as a new take of it, or below the leaf, as a new part. The same stops as the
 * TUI's `tui/src/aside-placement-model.ts`.
 */
export type PlacementStop =
  | { readonly kind: "take"; readonly partId: string; readonly partNumber: number; readonly parentId: string | null }
  | { readonly kind: "leaf"; readonly leafId: string; readonly partNumber: number };

/** What the writer picked. A stop is found again by this key, so a story that
 * changes under the choice cannot move it to another part. */
export type PlacementPick =
  | { readonly kind: "take"; readonly partId: string }
  | { readonly kind: "leaf" };

/** The direction the TUI writes on an inserted part. */
export const FROM_ASIDE_INSTRUCTION = "» from aside";

export function placementStops(payload: StoryPayload): readonly PlacementStop[] {
  const stops: PlacementStop[] = payload.path.map((node, index) => ({
    kind: "take" as const,
    partId: node.id,
    partNumber: index + 1,
    parentId: node.parentId
  }));
  const leaf = payload.path.at(-1);
  if (leaf !== undefined) stops.push({ kind: "leaf", leafId: leaf.id, partNumber: payload.path.length + 1 });
  return stops;
}

export function pickOfStop(stop: PlacementStop): PlacementPick {
  return stop.kind === "take" ? { kind: "take", partId: stop.partId } : { kind: "leaf" };
}

/** Where the choice starts: the part Aside was opened on, else the leaf's take. */
export function initialPick(payload: StoryPayload, partId: string | null): PlacementPick | null {
  const stops = placementStops(payload);
  if (stops.length === 0) return null;
  if (partId !== null && stops.some((stop) => stop.kind === "take" && stop.partId === partId)) {
    return { kind: "take", partId };
  }
  const lastTake = stops.findLast((stop) => stop.kind === "take");
  return lastTake === undefined ? null : pickOfStop(lastTake);
}

export function indexOfPick(stops: readonly PlacementStop[], pick: PlacementPick): number {
  const at = stops.findIndex((stop) => (pick.kind === "leaf"
    ? stop.kind === "leaf"
    : stop.kind === "take" && stop.partId === pick.partId));
  return at >= 0 ? at : Math.max(0, stops.findLastIndex((stop) => stop.kind === "take"));
}

export function parentOfStop(stop: PlacementStop): string | null {
  return stop.kind === "take" ? stop.parentId : stop.leafId;
}

/** What a stop says it will do. */
export function stopLabel(stop: PlacementStop): string {
  return stop.kind === "take" ? `new take of part ${stop.partNumber}` : `new part ${stop.partNumber}, after the last part`;
}

/** The take a create made: new, under the right parent, with this direction
 * and text. The server trims the text. */
export function findCreatedNode(
  payload: StoryPayload,
  known: ReadonlySet<string>,
  parentId: string | null,
  text: string
): StoryNode | undefined {
  const wanted = text.trim();
  return payload.path.find((node) => !known.has(node.id) && node.parentId === parentId
    && node.instruction === FROM_ASIDE_INSTRUCTION && node.text === wanted);
}
