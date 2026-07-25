export interface StoryViewportIntent {
  viewScroll: number | null;
  viewScrollDelta: number;
}

/** True once the reader has left semantic focus-following, including while a
 * relative move still awaits the next complete viewport derivation. */
export function isStoryViewportPinned(state: StoryViewportIntent): boolean {
  return state.viewScroll !== null || state.viewScrollDelta !== 0;
}

/** Follow semantic focus; any unpainted relative-scroll intent is obsolete. */
export function followStoryViewport(state: StoryViewportIntent): void {
  state.viewScroll = null;
  state.viewScrollDelta = 0;
}

/** Pin the viewport to an absolute wrapped-row offset. */
export function pinStoryViewport(state: StoryViewportIntent, start: number): void {
  state.viewScroll = Math.max(0, start);
  state.viewScrollDelta = 0;
}

/** Keep scrolling responsive before a cold frame has derived its new wrapped
 * row offset. The next complete frame applies this delta to its focus anchor. */
export function scrollStoryViewport(state: StoryViewportIntent, delta: number): void {
  if (state.viewScroll === null) {
    state.viewScrollDelta += delta;
    return;
  }
  state.viewScroll = Math.max(0, state.viewScroll + delta);
}
