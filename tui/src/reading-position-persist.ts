import {
  forgetReadingPosition,
  withRememberedFocus,
  type ReadingPositions
} from "./reading-position.js";
import {
  flushReadingPositionPersist as flushStore,
  markReadingPositionDirty
} from "./reading-position-store.js";
import type { RuntimeState } from "./state.js";

type FocusSource = {
  readingPositions: ReadingPositions;
  demo: boolean;
};

/** Update in-memory reading position; durable store write is debounced. */
export function rememberFocus(state: RuntimeState, source: FocusSource): void {
  if (source.demo || state.demo) return;
  const next = withRememberedFocus(
    state.readingPositions,
    state.payload,
    state.focusIndex,
    state.stream
  );
  if (next === state.readingPositions) return;
  state.readingPositions = next;
  source.readingPositions = next;
  const partId = next[state.payload.id];
  if (partId === undefined) return;
  markReadingPositionDirty(state.payload.id, partId);
}

/** Drop a deleted story from the store and flush. */
export function forgetStoryReadingPosition(
  state: RuntimeState,
  source: FocusSource,
  storyId: string
): void {
  flushStore();
  const next = forgetReadingPosition(state.readingPositions, storyId);
  if (next === state.readingPositions) {
    // Still mark delete so concurrent peers cannot resurrect a stale key on merge.
    markReadingPositionDirty(storyId, null);
    flushStore();
    return;
  }
  state.readingPositions = next;
  source.readingPositions = next;
  markReadingPositionDirty(storyId, null);
  flushStore();
}

export function flushReadingPositionPersist(): void {
  flushStore();
}
