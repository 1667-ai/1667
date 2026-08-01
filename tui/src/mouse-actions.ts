import type { MouseEvent } from "@opentui/core";
import { factRows } from "./facts-model.js";
import { hitAt } from "./hit.js";
import type { ResolvedKey } from "./keys.js";
import { generationBusy } from "./story-actions.js";
import type { RuntimeState } from "./state.js";

export type MouseGesture = Pick<
  MouseEvent,
  "type" | "button" | "x" | "y" | "modifiers" | "scroll"
>;

/** Everything a gesture needs to name what it landed on. The payload and
 *  stream are here because a cursor position is not an identity: the rows
 *  under an open menu or list are derived from the story, and reconciliation
 *  has to compare the row, not its index. */
export type MouseActionState = Pick<RuntimeState,
  | "mode" | "focusIndex" | "hitRows" | "map" | "payload" | "stream" | "demo"
  | "connection"
  | "actions" | "library" | "facts" | "commands" | "chapters" | "settings"
  | "search"
  | "request"
> & {
  /** Derived exactly as the panel renderer derives it, since the palette's
   *  rows — and therefore their indexes — depend on it. Optional so live
   *  `RuntimeState` still satisfies this type; a captured snapshot always
   *  carries it, and only snapshots are reconciled. */
  requestActive?: boolean;
};

/** Defer selectable story controls until a click proves it was not the start
 * of native text selection. OpenTUI owns the drag; repainting on mouse-down
 * moves or collapses the text beneath it. */
export interface SelectionSafeMouseGate {
  resolve(event: MouseGesture, resolved: ResolvedKey | null): ResolvedKey | null;
  reset(): void;
}

export interface FactDoubleClickGate {
  resolve(
    event: MouseGesture,
    resolved: ResolvedKey | null,
    state: MouseActionState
  ): ResolvedKey | null;
  reset(): void;
}

/**
 * Multi-event click gestures (selection-safe release, Fact double-click).
 * Keyboard/paste interrupt at enqueue time so a later mouse-down cannot finish
 * a pair text already broke. Already-captured mouse actions stay in the queue
 * and run FIFO — only incomplete gate state is cleared.
 */
export interface ClickGestureController {
  readonly gates: ReadonlyArray<{ reset(): void }>;
  /** Clear pending gate state (drag, scroll, frame loss, non-interactive paint). */
  reset(): void;
  /** Interrupt incomplete multi-event pairs at text-input enqueue time. */
  interrupt(): void;
}

export function createClickGestureController(
  gates: ReadonlyArray<{ reset(): void }>
): ClickGestureController {
  // reset and interrupt clear the same incomplete multi-event state; names
  // stay distinct at call sites (frame lifecycle vs text-input enqueue).
  const clear = () => {
    for (const gate of gates) gate.reset();
  };
  return {
    gates,
    reset: clear,
    interrupt: clear
  };
}

/** A Fact row uses one click for selection and two for editing. The first
 *  click on an already selected row stays quiet; it no longer opens a second
 *  inline reading surface inside the panel. */
export function createFactDoubleClickGate(
  now: () => number = Date.now,
  thresholdMs = 500
): FactDoubleClickGate {
  let previous: { id: string; at: number } | null = null;
  return {
    resolve(event, resolved, state) {
      // Shift-drag/click belongs to the terminal's own selection. mouseToAction
      // already returns null for Shift, but this gate hit-tests independently
      // and must not arm or complete a Fact edit from those events either.
      if (event.modifiers.shift) {
        previous = null;
        return resolved;
      }
      if (event.type === "drag" || event.type === "scroll") previous = null;
      if (event.type !== "down") return resolved;
      const target = event.button === 0 && state.facts !== null
        ? hitAt(state.hitRows, event.x, event.y)
        : null;
      if (target?.kind !== "list") {
        previous = null;
        return resolved;
      }
      const fact = factRows(
        state.payload.facts,
        state.facts!.selectedTag,
        state.facts!.query
      )[target.index];
      if (fact === undefined) {
        previous = null;
        return resolved;
      }
      const at = now();
      if (previous?.id === fact.id && at - previous.at <= thresholdMs) {
        previous = null;
        return { action: "edit", index: target.index, rowId: fact.id };
      }
      previous = { id: fact.id, at };
      return resolved?.action === "open-selected" ? null : resolved;
    },
    reset() {
      previous = null;
    }
  };
}

/** Keyboard and paste cancel pending mouse click gestures when text input is
 *  queued. The interrupt runs at wrap time so a second mouse-down cannot arm
 *  edit while the key still waits for a presented frame. */
export function withInterruptedClickGestures(
  controller: ClickGestureController,
  run: () => void | Promise<void>
): () => void | Promise<void> {
  controller.interrupt();
  return () => run();
}

export function createSelectionSafeMouseGate(): SelectionSafeMouseGate {
  let pending: { action: ResolvedKey; x: number; y: number } | null = null;
  return {
    resolve(event, resolved) {
      if (event.type === "down" && event.button === 0 && deferredStoryClick(resolved)) {
        pending = { action: resolved, x: event.x, y: event.y };
        return null;
      }
      if (event.type === "drag") {
        pending = null;
        return null;
      }
      if (event.type === "up") {
        const click = pending;
        pending = null;
        return click !== null && click.x === event.x && click.y === event.y
          && sameDeferredStoryClick(click.action, resolved)
          ? resolved : null;
      }
      if (event.type === "down" || event.type === "scroll") pending = null;
      return resolved;
    },
    reset() {
      pending = null;
    }
  };
}

function deferredStoryClick(action: ResolvedKey | null): action is ResolvedKey & { rowId: string } {
  return action?.rowId !== undefined
    && (action.action === "focus-index" || action.action === "toggle-prompt");
}

function sameDeferredStoryClick(pending: ResolvedKey, released: ResolvedKey | null): boolean {
  return released !== null
    && released.action === pending.action
    && released.rowId !== undefined
    && released.rowId === pending.rowId;
}

/** Freeze the reducer fields that belong to one native frame. */
export function captureMouseActionState(state: RuntimeState): MouseActionState {
  return {
    mode: state.mode,
    focusIndex: state.focusIndex,
    hitRows: state.hitRows,
    // Payloads are replaced wholesale, never mutated, so the reference is the
    // snapshot.
    payload: state.payload,
    stream: state.stream,
    demo: state.demo,
    // The palette's rows depend on both, so identifying one means seeing what
    // the frame that drew it saw.
    connection: state.connection,
    requestActive: generationBusy(state) || state.summary !== null,
    map: state.map === null ? null : {
      ...state.map,
      rowIds: [...state.map.rowIds],
      openedColdFolds: new Set(state.map.openedColdFolds)
    },
    actions: state.actions === null ? null : { ...state.actions },
    library: state.library === null ? null : {
      ...state.library,
      prompt: state.library.prompt === null
        ? null
        : state.library.prompt.kind === "filter"
          ? {
              ...state.library.prompt,
              initial: { ...state.library.prompt.initial }
            }
          : { ...state.library.prompt }
    },
    facts: state.facts === null ? null : { ...state.facts },
    commands: state.commands === null ? null : { ...state.commands },
    chapters: state.chapters === null ? null : { ...state.chapters },
    settings: state.settings === null ? null : { ...state.settings },
    search: state.search === null ? null : { ...state.search },
    request: state.request === null ? null : { ...state.request }
  };
}

/** True while any panel or modal owns the screen. */
export function overlayOpen(state: MouseActionState): boolean {
  return state.mode !== "NAV" && state.mode !== "COMPOSE";
}

/** Translate a mouse gesture into the same action vocabulary the keyboard
 *  uses, so one dispatch chain serves both. lazygit's model: the wheel
 *  scrolls, a click selects what it lands on, a click on the already-selected
 *  row runs it, right-click opens the part menu. */
export function mouseToAction(
  event: MouseGesture,
  state: MouseActionState,
  resolveReleaseTarget = false
): ResolvedKey | null {
  // Right-click leaves the composer rather than acting on what is under it.
  if (state.mode === "COMPOSE" && event.type === "down" && event.button === 2) return { action: "cancel" };
  // Shift-drag belongs to the terminal's own selection; never steal it.
  if (event.modifiers.shift) return null;
  if (event.type === "scroll") {
    const down = event.scroll?.direction === "down";
    if (state.mode === "REQUEST") return { action: down ? "scroll-line-down" : "scroll-line-up" };
    if (overlayOpen(state)) return { action: down ? "focus-next" : "focus-previous" };
    return { action: down ? "scroll-down" : "scroll-up" };
  }
  if (event.type !== "down" && !(resolveReleaseTarget && event.type === "up")) return null;

  let target = hitAt(state.hitRows, event.x, event.y);
  // Inline labels and gutter verbs yield to their broad row on other buttons,
  // so the part menu stays reachable over them. Standalone actions and rail
  // facts consume right-clicks instead of exposing content.
  if (event.button !== 0 && (target?.kind === "inline-action" || target?.kind === "action"
    || target?.kind === "prompt" || target?.kind === "story-take")) {
    target = hitAt(state.hitRows, event.x, event.y, false);
  }
  if (target === null) return null;

  if (target.kind === "scrim") return { action: "cancel" };
  if (target.kind === "settings-row" && event.button === 0) {
    return {
      action: "open-settings",
      settingsRow: target.row,
      ...(target.profilePurpose === undefined
        ? {}
        : { settingsProfilePurpose: target.profilePurpose })
    };
  }
  if (target.kind === "action" && event.button === 0) {
    return {
      action: target.action,
      ...(target.index === undefined ? {} : { index: target.index })
    };
  }
  if (target.kind === "inline-action" && event.button === 0) {
    if (target.action === "cancel" || target.action === "retry") return { action: target.action };
    if (state.mode === "NAV" || state.mode === "COMPOSE" && target.action === "open-request") {
      return { action: target.action };
    }
  }
  if (target.kind === "fact" && event.button === 0 && state.mode === "NAV") {
    return { action: "open-facts", index: target.index };
  }
  if (target.kind === "prompt" && event.button === 0 && state.mode === "NAV") {
    return { action: "toggle-prompt", index: target.index, rowId: target.rowId };
  }
  if (target.kind === "composer" && event.button === 0) return { action: "compose" };
  if (target.kind === "part") {
    // Carry the row identity its neighbours carry: an index alone cannot
    // survive a part landing or leaving above this one.
    if (event.button === 2) {
      return { action: "open-actions", index: target.index, rowId: target.rowId };
    }
    if (event.button !== 0) return null;
    // A click on prose only ever moves focus. Opening direction entry here made
    // dragging to select text start a generation — reported and removed.
    return { action: "focus-index", index: target.index, rowId: target.rowId };
  }
  if (target.kind === "chip" && event.button === 0) return { action: "cycle", index: target.index };
  if (target.kind === "take" && event.button === 0) return { action: "apply", index: target.row, take: target.take };
  if (target.kind === "map-view" && event.button === 0) return { action: "set-map-view", view: target.view };
  if (target.kind === "story-take" && event.button === 0 && state.mode === "NAV") {
    return { action: "take-at", take: target.take };
  }
  if (target.kind === "list" && event.button === 0) {
    const identity = target.rowId === undefined ? {} : { rowId: target.rowId };
    return (target.selected ?? listCursor(state) === target.index)
      ? { action: "open-selected", ...identity }
      : { action: "focus-index", index: target.index, ...identity };
  }
  return null;
}

/** Where the open overlay's cursor sits, for click-again-to-run. */
function listCursor(state: MouseActionState): number | null {
  if (state.request !== null) return state.request.cursor;
  if (state.actions !== null) return state.actions.cursor;
  if (state.library !== null) return state.library.cursor;
  if (state.facts !== null) return state.facts.cursor;
  if (state.commands !== null) return state.commands.cursor;
  if (state.chapters !== null) return state.chapters.cursor;
  if (state.settings !== null) return state.settings.cursor;
  if (state.search !== null) return state.search.cursor;
  // The map has no cursor index of its own; read it off the rendered rows
  // so the click and the frame always agree.
  if (state.mode === "MAP" && state.map !== null) {
    const cursorId = state.map.view === "path" ? state.map.pathCursorId : state.map.treeCursorId;
    if (cursorId === null) return null;
    const row = state.map.rowIds.indexOf(cursorId);
    return row === -1 ? null : row;
  }
  return null;
}
