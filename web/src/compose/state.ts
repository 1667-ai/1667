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
}

export interface ComposeState {
  readonly drafts: Readonly<Record<string, StoryComposeDraft>>;
  /** Sent directions of this browser session, oldest first. Shared by every
   * story, like the TUI's. Never saved. */
  readonly history: readonly string[];
  /** `history.length` means "not browsing": the composer shows live text. */
  readonly historyIndex: number;
  /** The text that was in the composer when browsing began, put back when
   * the writer walks past the newest entry. */
  readonly historyDraft: string | null;
  /** Raised by one each time something asks the composer to take keyboard
   * focus (Enter or `i` in the manuscript, starting a retake). */
  readonly focusRequest: number;
}

export function initialComposeState(): ComposeState {
  return { drafts: {}, history: [], historyIndex: 0, historyDraft: null, focusRequest: 0 };
}

const EMPTY_DRAFT: StoryComposeDraft = { direct: "", retake: null };

export function composeDraftOf(state: ComposeState, storyId: string): StoryComposeDraft {
  return state.drafts[storyId] ?? EMPTY_DRAFT;
}

/** The text the textarea shows: the retake's while one is open. */
export function visibleComposeText(draft: StoryComposeDraft): string {
  return draft.retake === null ? draft.direct : draft.retake.text;
}

export function isBrowsingHistory(state: ComposeState): boolean {
  return state.historyIndex !== state.history.length;
}
