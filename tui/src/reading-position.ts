/** Thin TUI wrapper over `shared/reading-position.ts`'s pure model: this
 *  module only adds the streamed `StoryViewModel` (`createStoryViewModel`,
 *  which projects a live stream on top of the payload) where the shared
 *  functions take an already-built stream-free manuscript model. Every
 *  export here keeps its original name and signature so the rest of the TUI
 *  (and its tests) import this exactly as before. */
import {
  forgetReadingPosition,
  mergeReadingPositionDirty,
  normalizeReadingPositions,
  openingFocusIndexOverManuscript,
  persistablePartIdOverManuscript,
  putReadingPositionOverManuscript,
  readingPartIdFor,
  MAX_READING_POSITIONS,
  type ReadingPositions
} from "../../shared/reading-position.js";
import type { StoryPayload } from "../../shared/types.js";
import { createStoryViewModel, type StoryViewModel } from "./model.js";
import type { StreamView } from "./state.js";

export {
  MAX_READING_POSITIONS,
  forgetReadingPosition,
  mergeReadingPositionDirty,
  normalizeReadingPositions,
  readingPartIdFor
};
export type { ReadingPositions };

/** Resolve where a story should open. A stored part wins when it still has a
 * row. Otherwise: the tour begins at its first part; every other story opens
 * at the end of its line (writer default). */
export function openingFocusIndex(
  payload: StoryPayload,
  readingPartId: string | null | undefined
): number {
  return openingFocusIndexOverManuscript(createStoryViewModel(payload), payload, readingPartId);
}

export function applyOpeningFocus(
  payload: StoryPayload,
  positions: ReadingPositions
): number {
  return openingFocusIndex(payload, readingPartIdFor(positions, payload.id));
}

/** Resolve a storeable part id for the focused row. Chapter dividers map to
 * the first part of the chapter they open; stream virtual rows return null. */
export function persistablePartId(
  view: StoryViewModel,
  focusIndex: number,
  payload: StoryPayload
): string | null {
  return persistablePartIdOverManuscript(view, focusIndex, payload);
}

/** Pure: set the focused part for a story. No-op when focus is not storeable. */
export function putReadingPosition(
  positions: ReadingPositions,
  storyId: string,
  view: StoryViewModel,
  focusIndex: number,
  payload: StoryPayload
): ReadingPositions {
  return putReadingPositionOverManuscript(positions, storyId, view, focusIndex, payload);
}

export function withRememberedFocus(
  positions: ReadingPositions,
  payload: StoryPayload,
  focusIndex: number,
  stream: StreamView | null = null
): ReadingPositions {
  // View may include a stream row for display, but putReadingPosition rejects
  // ids that are not on the authoritative payload.
  const view = createStoryViewModel(payload, stream);
  return putReadingPosition(positions, payload.id, view, focusIndex, payload);
}
