/**
 * Visible Placement destination markers on the story surface.
 * Only the selected stop is painted; Up/Down moves it with the stop.
 */
import type { PlacementState } from "../../aside-placement.js";
import {
  firstWords,
  type PlacementStop
} from "../../aside-placement-model.js";
import type { StoryPart, StoryRow, StoryViewModel } from "../../model.js";
import { segment, truncate, type FrameLine } from "./frame.js";
import type { ViewportBlock } from "./viewport.js";

/** Viewport / marker block id for the selected stop (not session-bound). */
export function placementFocusBlockId(placement: PlacementState): string | null {
  const stop = placement.stops[placement.cursor];
  if (stop === undefined) return null;
  return placementStopBlockId(stop);
}

export function placementStopBlockId(stop: PlacementStop): string {
  return stop.kind === "take"
    ? `placement:take:${stop.partId}`
    : `placement:leaf-gap:${stop.leafId}`;
}

/**
 * Enter-place hit identity: interaction session + destination stop.
 * Separate from viewport marker ids so session binding cannot hide markers.
 */
export function placementEnterPlaceRowId(placement: PlacementState): string | null {
  const stop = placement.stops[placement.cursor];
  if (stop === undefined) return null;
  return stop.kind === "take"
    ? `placement:${placement.interactionId}:take:${stop.partId}`
    : `placement:${placement.interactionId}:leaf-gap:${stop.leafId}`;
}

/**
 * Marker after a story row when that row owns the selected Take stop.
 * Leaf-gap markers use {@link placementLeafGapBlock} so they trail any chapter
 * summary/divider rows that follow the active leaf.
 */
export function placementMarkerAfterRow(
  placement: PlacementState | null | undefined,
  row: StoryRow,
  view: StoryViewModel,
  measure: number
): ViewportBlock | null {
  if (placement === null || placement === undefined) return null;
  const stop = placement.stops[placement.cursor];
  if (stop === undefined || stop.kind !== "take") return null;
  if (row.kind !== "part" || stop.partId !== row.id) return null;
  return takeMarkerBlock(stop, row, measure);
}

/**
 * Trailing leaf-gap destination. Call after every story row has been pushed so
 * the marker sits after chapter summary/divider chrome that follows the leaf.
 */
export function placementLeafGapBlock(
  placement: PlacementState | null | undefined,
  view: StoryViewModel,
  measure: number
): ViewportBlock | null {
  if (placement === null || placement === undefined) return null;
  const stop = placement.stops[placement.cursor];
  if (stop === undefined || stop.kind !== "leaf-gap") return null;
  const leaf = view.parts.at(-1);
  if (leaf === undefined || leaf.id !== stop.leafId) return null;
  return leafGapMarkerBlock(stop, placement.answer, measure);
}

function takeMarkerBlock(
  stop: Extract<PlacementStop, { kind: "take" }>,
  part: StoryPart,
  measure: number
): ViewportBlock {
  const nextTake = part.siblingCount + 1;
  const label = `take on ¶ ${stop.partNumber} · take ${nextTake}/${nextTake}`;
  return markerBlock(placementStopBlockId(stop), label, measure);
}

function leafGapMarkerBlock(
  stop: Extract<PlacementStop, { kind: "leaf-gap" }>,
  answer: string,
  measure: number
): ViewportBlock {
  const preview = firstWords(answer, 8);
  const label = preview.length === 0
    ? "here · new Part"
    : `here · new Part · ${preview}`;
  return markerBlock(placementStopBlockId(stop), label, measure);
}

function markerBlock(partId: string, label: string, measure: number): ViewportBlock {
  const painted: FrameLine = [
    segment(truncate(`▸ ${label}`, Math.max(1, measure)), "focus / accent")
  ];
  return {
    partId,
    partIndex: -1,
    height: 2,
    render: () => [painted, []]
  };
}
