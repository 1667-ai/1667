/**
 * Aside surface state helpers. Side Notes load only through getAside.
 */
import type { ComposerState } from "./composer-model.js";
import { createComposer } from "./composer-model.js";
import type { TextPresentation } from "./text-presentation.js";

export interface AsideNoteView {
  readonly question: string;
  readonly answer: string;
}

export type AsideFocus = "composer" | "notes";

/** Use menu for one complete saved Side Note answer. */
export interface AsideUseMenuState {
  noteIndex: number;
  /** Index into the stage's use-menu action list. */
  cursor: number;
  /**
   * Fresh identity for this menu open. Hit reconciliation binds list/apply
   * clicks to it so a queued click for note A cannot run after the writer
   * opens note B. Survives repaint and Placement Esc restoration; changes on
   * every openAsideUseMenu.
   */
  sessionId: string;
}

export interface AsideSurfaceState {
  readonly storyId: string;
  storyTitle: string;
  notes: AsideNoteView[];
  composer: ComposerState;
  /** Text streaming from the current ask, if any. */
  streamText: string;
  /** Visible prefix controller; `streamText` remains authoritative. */
  presentation?: TextPresentation;
  /** Stop hides the live answer before the backend confirms its result. */
  streamHidden?: boolean;
  /** Question currently being answered; returned to the input on failure. */
  inflightQuestion: string | null;
  /** First wrapped history row; null follows the newest content. */
  scrollTop: number | null;
  confirmClear: boolean;
  busy: boolean;
  /** Seed question from `/aside <question>` after the surface opens. */
  pendingAsk: string | null;
  /** Keyboard focus: the Aside composer or the Side Note list. */
  focus: AsideFocus;
  /** Index of the focused complete Side Note when focus is notes. */
  noteCursor: number;
  /** Use menu for one complete saved answer, or null when closed. */
  useMenu: AsideUseMenuState | null;
  /**
   * Story Part id focused when Aside opened. Placement starts here when the
   * Part still exists. Anchors are not used in this stage.
   */
  openingPartId: string | null;
}

export function createAsideSurface(
  storyId: string,
  storyTitle: string,
  notes: readonly AsideNoteView[] = [],
  pendingAsk: string | null = null,
  openingPartId: string | null = null
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
    pendingAsk,
    focus: "composer",
    noteCursor: Math.max(0, notes.length - 1),
    useMenu: null,
    openingPartId
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
