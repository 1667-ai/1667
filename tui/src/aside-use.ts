/**
 * Aside use menu and local backcopy actions.
 * Stage 1: insert into compose. Stage 2: insert into story… (Placement).
 */
import { countWords } from "../../shared/story-text.js";
import { closeAside } from "./aside-actions.js";
import { openPlacementFromAside } from "./aside-placement.js";
import { insertComposerText } from "./composer-model.js";
import { openDirectComposer } from "./composer-ownership.js";
import { disarmAsideClear, type AsideSurfaceState } from "./aside-surface.js";
import type { RuntimeState } from "./state.js";

export type AsideUseActionId = "insert-into-compose" | "insert-into-story";

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
  }
];

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
  sessionId: string
): number {
  const prefix = `aside-use:${sessionId}:`;
  if (!rowId.startsWith(prefix)) return -1;
  const actionId = rowId.slice(prefix.length);
  return ASIDE_USE_ACTIONS.findIndex((entry) => entry.id === actionId);
}

export function asideUseMenuTitle(answer: string): string {
  const words = countWords(answer);
  const label = words === 1 ? "1 word" : `${words.toLocaleString("en-US")} words`;
  return `use answer · ${label}`;
}

export function openAsideUseMenu(
  surface: AsideSurfaceState,
  noteIndex: number,
  cursor = 0
): boolean {
  if (surface.busy) return false;
  if (noteIndex < 0 || noteIndex >= surface.notes.length) return false;
  disarmAsideClear(surface);
  surface.focus = "notes";
  surface.noteCursor = noteIndex;
  surface.useMenu = {
    noteIndex,
    cursor: Math.max(0, Math.min(ASIDE_USE_ACTIONS.length - 1, cursor)),
    // New id every open so A→B menu clicks cannot reconcile on action alone.
    sessionId: crypto.randomUUID()
  };
  return true;
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
  menu.cursor = Math.max(
    0,
    Math.min(ASIDE_USE_ACTIONS.length - 1, menu.cursor + delta)
  );
}

/** Absolute use-menu row from a mouse focus-index hit. */
export function focusAsideUseMenuIndex(
  surface: AsideSurfaceState,
  index: number
): void {
  const menu = surface.useMenu;
  if (menu === null) return;
  menu.cursor = Math.max(0, Math.min(ASIDE_USE_ACTIONS.length - 1, index));
}

/**
 * Tab moves focus between the Aside composer and the Side Note list.
 * Busy Ask/Clear keeps the composer so Esc can still stop an Ask.
 */
export function cycleAsideFocus(surface: AsideSurfaceState): boolean {
  if (surface.busy || surface.useMenu !== null) return false;
  if (surface.notes.length === 0) return false;
  if (surface.focus === "composer") {
    disarmAsideClear(surface);
    surface.focus = "notes";
    surface.noteCursor = Math.max(
      0,
      Math.min(surface.notes.length - 1, surface.noteCursor)
    );
    return true;
  }
  surface.focus = "composer";
  return true;
}

export function moveAsideNoteFocus(
  surface: AsideSurfaceState,
  delta: number
): void {
  if (surface.busy || surface.notes.length === 0) return;
  const next = Math.max(
    0,
    Math.min(surface.notes.length - 1, surface.noteCursor + delta)
  );
  surface.noteCursor = next;
  surface.focus = "notes";
}

/**
 * Insert the complete Side Note answer at the persistent Direct composer
 * cursor, close Aside, and open Compose. Preserves the Direct draft and
 * selection/cursor semantics via insertComposerText.
 */
export function insertAsideAnswerIntoCompose(
  state: RuntimeState,
  noteIndex: number
): boolean {
  const surface = state.aside;
  if (surface === null) return false;
  const note = surface.notes[noteIndex];
  if (note === undefined) return false;
  if (state.stream !== null) {
    state.toast = "stream running · esc stops it first";
    return false;
  }
  const answer = note.answer;
  closeAside(state);
  if (!openDirectComposer(state)) {
    state.toast = "stream running · esc stops it first";
    return false;
  }
  insertComposerText(state.composer, answer);
  return true;
}

/** Apply the focused use-menu action. Returns which path ran, or false. */
export function applyAsideUseMenu(
  state: RuntimeState
): "compose" | "placement" | false {
  const surface = state.aside;
  if (surface === null || surface.useMenu === null) return false;
  const action = ASIDE_USE_ACTIONS[surface.useMenu.cursor];
  if (action === undefined) return false;
  const noteIndex = surface.useMenu.noteIndex;
  if (action.id === "insert-into-compose") {
    closeAsideUseMenu(surface);
    return insertAsideAnswerIntoCompose(state, noteIndex) ? "compose" : false;
  }
  // Placement owns closing the menu and Aside surface.
  return openPlacementFromAside(state) ? "placement" : false;
}
