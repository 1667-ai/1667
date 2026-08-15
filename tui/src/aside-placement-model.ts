/**
 * Pure Placement stop model. Free of story-adoption and mutation I/O so
 * adoption can rebase stops without an import cycle.
 */
import type { StoryNode, StoryPayload } from "../../shared/types.js";

export type PlacementStop =
  | {
      kind: "take";
      partId: string;
      partNumber: number;
      parentId: string | null;
    }
  | {
      kind: "leaf-gap";
      leafId: string;
      partNumber: number;
    };

export interface PlacementStopSelection {
  stops: PlacementStop[];
  cursor: number;
}

/**
 * Identity of one Placement createNode submission.
 * Retained after an uncertain failure so same-story recovery can settle.
 */
export interface PlacementPendingSubmission {
  /** Node ids known when createNode was submitted. */
  knownNodeIds: ReadonlySet<string>;
  parentId: string | null;
  instruction: string;
  text: string;
  partNumber: number;
}

/**
 * Story-bound unresolved Placement create after an uncertain outcome.
 * Survives Esc back to Aside until recovery settles it or a definite failure
 * proves the write did not commit.
 */
export interface UnresolvedPlacementSubmission {
  storyId: string;
  submission: PlacementPendingSubmission;
}

/**
 * Match an uncertain Placement submission against an authoritative payload.
 * Requires exact active-path text and instruction. Off-path stubs only carry
 * preview/word-count/instruction-presence and must not clear the guard.
 */
export function findSubmittedPlacementNode(
  payload: StoryPayload,
  submission: PlacementPendingSubmission
): StoryNode | undefined {
  return payload.path.find((node) =>
    !submission.knownNodeIds.has(node.id)
    && node.parentId === submission.parentId
    && node.instruction === submission.instruction
    && node.text === submission.text
  );
}

export function buildPlacementStops(payload: StoryPayload): PlacementStop[] {
  const stops: PlacementStop[] = payload.path.map((node, pathIndex) => ({
    kind: "take" as const,
    partId: node.id,
    partNumber: pathIndex + 1,
    parentId: node.parentId
  }));
  const leaf = payload.path.at(-1);
  if (leaf !== undefined) {
    stops.push({
      kind: "leaf-gap",
      leafId: leaf.id,
      partNumber: payload.path.length + 1
    });
  }
  return stops;
}

export function initialPlacementCursor(
  stops: readonly PlacementStop[],
  openingPartId: string | null
): number {
  if (stops.length === 0) return 0;
  if (openingPartId !== null) {
    const match = stops.findIndex(
      (stop) => stop.kind === "take" && stop.partId === openingPartId
    );
    if (match >= 0) return match;
  }
  // Prefer the active leaf's Take stop when the opening Part is gone.
  const lastTake = stops.findLastIndex((stop) => stop.kind === "take");
  return lastTake >= 0 ? lastTake : 0;
}

/**
 * Rebase Placement stops onto a newer same-story payload.
 * - Selected Take: keep by node id when present.
 * - Selected trailing gap: follow the new active leaf.
 * - Missing Take: fall back to the active leaf's Take stop.
 */
export function rebasePlacementStops(
  selection: PlacementStopSelection,
  payload: StoryPayload
): void {
  const previous = selection.stops[selection.cursor];
  const stops = buildPlacementStops(payload);
  selection.stops = stops;
  if (stops.length === 0) {
    selection.cursor = 0;
    return;
  }
  if (previous === undefined) {
    selection.cursor = initialPlacementCursor(stops, null);
    return;
  }
  if (previous.kind === "take") {
    const match = stops.findIndex(
      (stop) => stop.kind === "take" && stop.partId === previous.partId
    );
    selection.cursor = match >= 0
      ? match
      : initialPlacementCursor(stops, null);
    return;
  }
  const gap = stops.findIndex((stop) => stop.kind === "leaf-gap");
  selection.cursor = gap >= 0 ? gap : initialPlacementCursor(stops, null);
}

/** Shared answer preview for status labels and story destination markers. */
export function firstWords(text: string, count: number): string {
  const words = text.trim().split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) return "";
  const slice = words.slice(0, count).join(" ");
  return words.length > count ? `${slice}…` : slice;
}
