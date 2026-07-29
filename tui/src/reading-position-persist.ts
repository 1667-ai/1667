import {
  forgetReadingPosition,
  withRememberedFocus,
  type ReadingPositions
} from "./reading-position.js";
import {
  flushReadingPositionPersist as flushStore,
  queueReadingPositionPersist
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
  queueReadingPositionPersist(next);
}

/** Drop a deleted story from the store and flush. */
export function forgetStoryReadingPosition(
  state: RuntimeState,
  source: FocusSource,
  storyId: string
): void {
  flushStore();
  const next = forgetReadingPosition(state.readingPositions, storyId);
  if (next === state.readingPositions) return;
  state.readingPositions = next;
  source.readingPositions = next;
  // Immediate write: delete should not wait on the debounce window.
  queueReadingPositionPersist(next);
  flushStore();
}

export function flushReadingPositionPersist(): void {
  flushStore();
}
