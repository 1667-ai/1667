/**
 * The composer's text (#409 step 6), kept in the store so it survives a
 * route change, a re-render, and a failed run that hands a draft back. Only
 * the writer's own typing and the draft handle (`draft-handle.ts`) write it.
 */

/** A retake in progress: the part it replaces and the direction typed so
 * far. While it is set, the composer is in retake mode. */
export interface RetakeDraft {
  readonly nodeId: string;
  readonly text: string;
}

/** One story's composer: the Direct text, and the retake that is set over
 * it. The Direct text stays here while a retake is open, and comes back when
 * the retake ends. */
export interface StoryComposeDraft {
  readonly direct: string;
  readonly retake: RetakeDraft | null;
  /** A walk through the history, per story: where it is, and the text the
   * box held when it began (put back when the walk passes the newest entry).
   * `null` while the box shows live text. */
  readonly walk: HistoryWalk | null;
}

export interface HistoryWalk {
  readonly index: number;
  readonly draft: string;
}

export interface ComposeState {
  readonly drafts: Readonly<Record<string, StoryComposeDraft>>;
  /** Sent directions of this browser session, oldest first. Shared by every
   * story, like the TUI's. Never saved. */
  readonly history: readonly string[];
  /** Raised by one each time something asks the composer to take keyboard
   * focus (Enter or `i` in the manuscript, starting a retake). */
  readonly focusRequest: number;
}

export function initialComposeState(): ComposeState {
  return { drafts: {}, history: [], focusRequest: 0 };
}

const EMPTY_DRAFT: StoryComposeDraft = { direct: "", retake: null, walk: null };

export function composeDraftOf(state: ComposeState, storyId: string): StoryComposeDraft {
  return state.drafts[storyId] ?? EMPTY_DRAFT;
}

/** The text the textarea shows: the retake's while one is open. */
export function visibleComposeText(draft: StoryComposeDraft): string {
  return draft.retake === null ? draft.direct : draft.retake.text;
}

export function isBrowsingHistory(draft: StoryComposeDraft): boolean {
  return draft.walk !== null;
}
