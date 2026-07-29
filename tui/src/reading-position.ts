import { STARTER_OPENING_STORY_ID } from "../../shared/starter-vault.js";
import type { StoryPayload } from "../../shared/types.js";
import {
  createStoryViewModel,
  lastPartRowIndex,
  rowIndexForNode,
  rowPart,
  type StoryViewModel
} from "./model.js";
import type { StreamView } from "./state.js";

/** Story id → last focused part id. Local changing store, not settings. */
export type ReadingPositions = Readonly<Record<string, string>>;

const MAX_READING_POSITIONS = 256;

export function normalizeReadingPositions(value: unknown): ReadingPositions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const next: Record<string, string> = {};
  for (const [storyId, partId] of Object.entries(value)) {
    if (typeof storyId !== "string" || storyId.length === 0) continue;
    if (typeof partId !== "string" || partId.length === 0) continue;
    next[storyId] = partId;
    if (Object.keys(next).length >= MAX_READING_POSITIONS) break;
  }
  return next;
}

export function readingPartIdFor(
  positions: ReadingPositions,
  storyId: string
): string | null {
  return positions[storyId] ?? null;
}

/** Resolve where a story should open. A stored part wins when it still has a
 * row. Otherwise: the tour begins at its first part; every other story opens
 * at the end of its line (writer default). */
export function openingFocusIndex(
  payload: StoryPayload,
  readingPartId: string | null | undefined
): number {
  const view = createStoryViewModel(payload);
  if (payload.path.length === 0) return 0;
  if (readingPartId !== null && readingPartId !== undefined && readingPartId.length > 0) {
    const index = rowIndexForNode(view, readingPartId);
    if (index >= 0) return index;
  }
  if (payload.id === STARTER_OPENING_STORY_ID) return firstPartRowIndex(view);
  return lastPartRowIndex(view);
}

export function applyOpeningFocus(
  payload: StoryPayload,
  positions: ReadingPositions
): number {
  return openingFocusIndex(payload, readingPartIdFor(positions, payload.id));
}

/** Pure: set the focused part for a story. No-op when focus is not a part. */
export function putReadingPosition(
  positions: ReadingPositions,
  storyId: string,
  view: StoryViewModel,
  focusIndex: number
): ReadingPositions {
  const part = rowPart(view, focusIndex);
  if (part === null) return positions;
  if (positions[storyId] === part.id) return positions;
  return trimReadingPositions({ ...positions, [storyId]: part.id }, storyId);
}

export function forgetReadingPosition(
  positions: ReadingPositions,
  storyId: string
): ReadingPositions {
  if (positions[storyId] === undefined) return positions;
  const next = { ...positions };
  delete next[storyId];
  return next;
}

export function withRememberedFocus(
  positions: ReadingPositions,
  payload: StoryPayload,
  focusIndex: number,
  stream: StreamView | null = null
): ReadingPositions {
  const view = createStoryViewModel(payload, stream);
  return putReadingPosition(positions, payload.id, view, focusIndex);
}

function firstPartRowIndex(view: StoryViewModel): number {
  for (let index = 0; index < view.rows.length; index += 1) {
    if (view.rows[index]?.kind === "part") return index;
  }
  return 0;
}

function trimReadingPositions(
  positions: Record<string, string>,
  keepStoryId: string
): ReadingPositions {
  const kept = new Map(Object.entries(positions));
  if (kept.size <= MAX_READING_POSITIONS) return positions;
  for (const key of [...kept.keys()]) {
    if (kept.size <= MAX_READING_POSITIONS) break;
    if (key === keepStoryId) continue;
    kept.delete(key);
  }
  return Object.fromEntries(kept);
}
