/**
 * Aside surface state helpers. Side Notes load only through getAside.
 */
import type { ComposerState } from "./composer-model.js";
import { createComposer } from "./composer-model.js";

export interface AsideNoteView {
  readonly question: string;
  readonly answer: string;
}

export interface AsideSurfaceState {
  readonly storyId: string;
  storyTitle: string;
  notes: AsideNoteView[];
  composer: ComposerState;
  /** Text streaming from the current ask, if any. */
  streamText: string;
  /** Question currently being answered; returned to the input on failure. */
  inflightQuestion: string | null;
  /** First wrapped history row; null follows the newest content. */
  scrollTop: number | null;
  confirmClear: boolean;
  busy: boolean;
  /** Seed question from `/aside <question>` after the surface opens. */
  pendingAsk: string | null;
}

export function createAsideSurface(
  storyId: string,
  storyTitle: string,
  notes: readonly AsideNoteView[] = [],
  pendingAsk: string | null = null
): AsideSurfaceState {
  return {
    storyId,
    storyTitle,
    notes: notes.map((note) => ({ question: note.question, answer: note.answer })),
    composer: createComposer(),
    streamText: "",
    inflightQuestion: null,
    scrollTop: null,
    confirmClear: false,
    busy: false,
    pendingAsk
  };
}

/** Any composer edit makes an earlier Clear confirmation stale. */
export function disarmAsideClear(surface: Pick<AsideSurfaceState, "confirmClear">): void {
  surface.confirmClear = false;
}

export function asideHeaderLine(storyTitle: string): string {
  return `ASIDE · ${storyTitle} · non-canon`;
}

export const ASIDE_SAVED_NOTICE =
  "Side Notes are saved with this story. They never enter story prompts.";

export const ASIDE_INPUT_PLACEHOLDER = "Ask about this story";
