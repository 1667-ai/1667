/**
 * Aside use menu and local backcopy actions.
 * Stage 1: insert into compose. Stage 2: insert into story… (Placement).
 */
import { countWords } from "../../shared/story-text.js";
import { closeAside } from "./aside-actions.js";
import { openPlacementFromAside } from "./aside-placement.js";
import { copyStoryText } from "./copy-actions.js";
import { insertComposerText } from "./composer-model.js";
import { openDirectComposer } from "./composer-ownership.js";
import { openFactFromSelection } from "./editor-action.js";
import {
  asideCursor,
  asideNotes,
  disarmAsideClear,
  setAsideCursor,
  type AsideSurfaceState
} from "./aside-surface.js";
import type { RuntimeState } from "./state.js";
import type { StorySelectionSpan } from "./selection-projection.js";

export type AsideUseActionId =
  | "copy"
  | "insert-into-compose"
  | "insert-into-story"
  | "insert-as-new-fact";

export interface AsideUseAction {
  readonly id: AsideUseActionId;
  readonly name: string;
  readonly description: string;
}

/** Current-stage actions only. Do not list future actions as disabled rows. */
export const ASIDE_USE_ACTIONS: readonly AsideUseAction[] = [
  {
    id: "insert-into-compose",
    name: "insert into compose",
    description: "insert at the composer cursor"
  },
  {
    id: "insert-into-story",
    name: "insert into story…",
    description: "select a position, then confirm"
  },
  {
    id: "insert-as-new-fact",
    name: "insert as new Fact",
    description: "edit the answer and optional tag"
  }
];

const ASIDE_SELECTION_USE_ACTION: AsideUseAction = {
  id: "copy",
  name: "Copy",
  description: "copy the highlighted text"
};

/** The selected-text menu adds Copy before the complete-answer actions. Keep
 * the complete-answer list stable so existing keyboard and Placement paths
 * retain their row order. */
export function asideUseActions(
  selectionText?: string
): readonly AsideUseAction[] {
  return selectionText === undefined
    ? ASIDE_USE_ACTIONS
    : [
      ASIDE_SELECTION_USE_ACTION,
      ASIDE_USE_ACTIONS.find(({ id }) => id === "insert-into-compose")!,
      ASIDE_USE_ACTIONS.find(({ id }) => id === "insert-as-new-fact")!,
      ASIDE_USE_ACTIONS.find(({ id }) => id === "insert-into-story")!
    ];
}

/** Hit-map / selection identity for one use-menu action in one menu session. */
export function asideUseRowId(
  sessionId: string,
  actionId: AsideUseActionId
): string {
  return `aside-use:${sessionId}:${actionId}`;
}

/** Resolve a session-bound use-menu row id to its action index, or -1. */
export function asideUseActionIndexFromRowId(
  rowId: string,
  sessionId: string,
  selectionText?: string
): number {
  const prefix = `aside-use:${sessionId}:`;
  if (!rowId.startsWith(prefix)) return -1;
  const actionId = rowId.slice(prefix.length);
  return asideUseActions(selectionText).findIndex((entry) => entry.id === actionId);
}

export function asideUseMenuTitle(answer: string, selectionText?: string): string {
  const words = countWords(selectionText ?? answer);
  const label = words === 1 ? "1 word" : `${words.toLocaleString("en-US")} words`;
  return `use ${selectionText === undefined ? "answer" : "selection"} · ${label}`;
}

export function openAsideUseMenu(
  surface: AsideSurfaceState,
  noteIndex: number,
  cursor = 0,
  selectionText?: string,
  selectionSpans: readonly StorySelectionSpan[] = []
): boolean {
  if (surface.busy) return false;
  const notes = asideNotes(surface);
  if (noteIndex < 0 || noteIndex >= notes.length) return false;
  const actions = asideUseActions(selectionText);
  disarmAsideClear(surface);
  surface.focus = "notes";
  setAsideCursor(surface, noteIndex);
  surface.useMenu = {
    noteIndex,
    ...(selectionText === undefined ? {} : { selectionText }),
    ...(selectionSpans.length === 0 ? {} : { selectionSpans: selectionSpans.slice() }),
    cursor: Math.max(0, Math.min(actions.length - 1, cursor)),
    // New id every open so A→B menu clicks cannot reconcile on action alone.
    sessionId: crypto.randomUUID()
  };
  return true;
}

/** Open a mouse-targeted menu without changing the active Aside viewport. */
export function openAsideUseMenuFromMouse(
  surface: AsideSurfaceState,
  noteIndex: number,
  selectionText?: string,
  selectionSpans: readonly StorySelectionSpan[] = []
): boolean {
  const focus = surface.focus;
  const cursor = asideCursor(surface);
  const opened = openAsideUseMenu(
    surface, noteIndex, 0, selectionText, selectionSpans
  );
  surface.focus = focus;
  setAsideCursor(surface, cursor);
  return opened;
}

export function closeAsideUseMenu(surface: AsideSurfaceState): void {
  surface.useMenu = null;
}

export function moveAsideUseMenuCursor(
  surface: AsideSurfaceState,
  delta: number
): void {
  const menu = surface.useMenu;
  if (menu === null) return;
  const actions = asideUseActions(menu.selectionText);
  menu.cursor = Math.max(
    0,
    Math.min(actions.length - 1, menu.cursor + delta)
  );
}

/** Absolute use-menu row from a mouse focus-index hit. */
export function focusAsideUseMenuIndex(
  surface: AsideSurfaceState,
  index: number
): void {
  const menu = surface.useMenu;
  if (menu === null) return;
  const actions = asideUseActions(menu.selectionText);
  menu.cursor = Math.max(0, Math.min(actions.length - 1, index));
}

/**
 * Tab moves focus between the Aside composer and the Side Note list.
 * Busy Ask/Clear keeps the composer so Esc can still stop an Ask.
 */
export function cycleAsideFocus(surface: AsideSurfaceState): boolean {
  if (surface.busy || surface.useMenu !== null) return false;
  const notes = asideNotes(surface);
  if (notes.length === 0) return false;
  if (surface.focus === "composer") {
    disarmAsideClear(surface);
    surface.focus = "notes";
    setAsideCursor(surface, Math.max(
      0,
      Math.min(notes.length - 1, asideCursor(surface))
    ));
    return true;
  }
  surface.focus = "composer";
  return true;
}

export function moveAsideNoteFocus(
  surface: AsideSurfaceState,
  delta: number
): void {
  const notes = asideNotes(surface);
  if (surface.busy || notes.length === 0) return;
  const next = Math.max(
    0,
    Math.min(notes.length - 1, asideCursor(surface) + delta)
  );
  setAsideCursor(surface, next);
  surface.focus = "notes";
}

/**
 * Insert the complete Side Note answer at the persistent Direct composer
 * cursor, close Aside, and open Compose. Preserves the Direct draft and
 * selection/cursor semantics via insertComposerText.
 */
export function insertAsideAnswerIntoCompose(
  state: RuntimeState,
  noteIndex: number,
  selectedText?: string
): boolean {
  const surface = state.aside;
  if (surface === null) return false;
  const note = asideNotes(surface)[noteIndex];
  if (note === undefined) return false;
  if (state.stream !== null) {
    state.toast = "stream running · esc stops it first";
    return false;
  }
  const answer = selectedText ?? note.answer;
  closeAside(state);
  if (!openDirectComposer(state)) {
    state.toast = "stream running · esc stops it first";
    return false;
  }
  insertComposerText(state.composer, answer);
  return true;
}

/** Apply the focused use-menu action. Returns which path ran, or false. */
export async function applyAsideUseMenu(
  state: RuntimeState
): Promise<"copy" | "compose" | "fact" | "placement" | false> {
  const surface = state.aside;
  if (surface === null || surface.useMenu === null) return false;
  const menu = surface.useMenu;
  const action = asideUseActions(menu.selectionText)[menu.cursor];
  if (action === undefined) return false;
  const noteIndex = menu.noteIndex;
  const note = asideNotes(surface)[noteIndex];
  const text = menu.selectionText ?? note?.answer;
  if (text === undefined) return false;
  if (action.id === "copy") {
    closeAsideUseMenu(surface);
    await copyStoryText(state, { kind: "selection", text });
    return "copy";
  }
  if (action.id === "insert-into-compose") {
    closeAsideUseMenu(surface);
    return insertAsideAnswerIntoCompose(state, noteIndex, menu.selectionText) ? "compose" : false;
  }
  if (action.id === "insert-as-new-fact") {
    closeAside(state);
    openFactFromSelection(state, text);
    return "fact";
  }
  // Placement owns closing the menu and Aside surface.
  return openPlacementFromAside(state) ? "placement" : false;
}
