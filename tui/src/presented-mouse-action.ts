import type { MouseEvent } from "@opentui/core";
import { hitAt } from "./hit.js";
import type { ResolvedKey } from "./keys.js";
import { factRows } from "./facts-model.js";
import { libraryRows } from "./library-model.js";
import { currentPartActions } from "./story-actions.js";
import { createStoryViewModel, rowPart } from "./model.js";
import { SETTINGS_ROW_IDS } from "./settings-overlay-model.js";
import {
  mouseToAction,
  type MouseActionState,
  type MouseGesture
} from "./mouse-actions.js";
import type { RuntimeState } from "./state.js";

export interface PresentedInteraction {
  version: number;
  frameToken: number;
  interactive: boolean;
  storyId: string;
  state: MouseActionState;
}

export type FrozenMouseEvent = MouseGesture;

/** A failed surface update may leave native partial pixels visible without a
 * matching application-frame token. Never interpret them through the previous
 * interactive snapshot. */
export function canCapturePresentedMouseAction(
  presented: PresentedInteraction | null,
  frameFailed: boolean
): presented is PresentedInteraction {
  return !frameFailed && presented?.interactive === true;
}

/** Native event objects are renderer-owned. Keep only immutable gesture data
 * while an earlier queued input waits for its presented frame. */
export function freezeMouseEvent(event: MouseEvent): FrozenMouseEvent {
  return {
    type: event.type,
    button: event.button,
    x: event.x,
    y: event.y,
    modifiers: { ...event.modifiers },
    ...(event.scroll === undefined ? {} : { scroll: { ...event.scroll } })
  };
}

export interface PresentedMouseReconciliation {
  action: ResolvedKey;
  event: FrozenMouseEvent;
  captured: PresentedInteraction;
  presented: PresentedInteraction | null;
  state: RuntimeState;
}

/** Reconcile a gesture emitted by one presented frame with the frame visible
 * when its queue slot runs. Clock-only paint may move cells, so re-resolve the
 * coordinate and prove it still names the same semantic target. */
export function reconcilePresentedMouseAction({
  action,
  event,
  captured,
  presented,
  state
}: PresentedMouseReconciliation): ResolvedKey | null {
  // The queue only runs an input while the presented frame owns current state,
  // so "the newest built frame" and "the newest requested frame" are the same
  // one here. What remains to prove is the owner and the target.
  if (presented === null || !presented.interactive
    || presented.storyId !== state.payload.id
    || presented.state.mode !== state.mode) {
    return null;
  }

  if (captured.storyId !== presented.storyId
    || captured.state.mode !== presented.state.mode) {
    return null;
  }
  if (captured === presented) return action;

  // A gesture carrying its own stable identity is rebased against live state
  // first: its row may sit at a different index than any frame recorded.
  const rebased = rebaseByStableIdentity(action, state);
  if (rebased !== null) return rebased;
  // Everything else re-resolves against the presented frame, whose hit map is
  // what the writer is looking at, and is delivered when it still names the
  // same thing. A repaint that was only pending when the click arrived moved
  // nothing — dropping those is what made clicking a control feel unreliable
  // while the story streamed.
  const latest = mouseToAction(event, presented.state, event.type === "up");
  if (latest === null || !sameMouseTarget(
    action, captured.state, latest, presented.state, event
  )) return null;
  return {
    ...latest,
    ...(action.selectionText === undefined ? {} : { selectionText: action.selectionText }),
    ...(action.selectionSpans === undefined ? {} : { selectionSpans: action.selectionSpans })
  };
}

/** The action a gesture still names when it carries an identity of its own:
 *  a row id outlives the index any frame recorded for it, and a relative
 *  gesture names no cell at all. Null means "no identity here, ask the frame".
 *  The caller has already proved captured, presented and live state share an
 *  owner. */
function rebaseByStableIdentity(
  action: ResolvedKey,
  state: RuntimeState
): ResolvedKey | null {
  if (action.action === "focus-index" && action.rowId !== undefined) {
    const index = createStoryViewModel(state.payload, state.stream).rows
      .findIndex((row) => row.id === action.rowId);
    return index < 0 ? null : { ...action, index };
  }
  return relativeMouseAction(action) ? action : null;
}

function sameMouseTarget(
  before: ResolvedKey,
  beforeState: MouseActionState,
  after: ResolvedKey,
  afterState: MouseActionState,
  event: FrozenMouseEvent
): boolean {
  if (before.action !== after.action) return false;
  if (before.action === "focus-index") {
    if (before.rowId !== undefined || after.rowId !== undefined) {
      return before.rowId !== undefined && before.rowId === after.rowId;
    }
    if (beforeState.mode === "MAP" && afterState.mode === "MAP") {
      return beforeState.map?.view === afterState.map?.view
        && mapRowId(beforeState, before.index) !== null
        && mapRowId(beforeState, before.index) === mapRowId(afterState, after.index);
    }
  }
  if (before.action === "open-selected") {
    const beforeSelection = selectedListIdentity(beforeState);
    if (beforeSelection === null || beforeSelection !== selectedListIdentity(afterState)) return false;
    if (beforeState.mode === "MAP" && beforeState.map?.view === "tree") {
      const beforeRow = mapRowAt(beforeState, event);
      const afterRow = mapRowAt(afterState, event);
      return beforeRow !== null && afterRow !== null
        && beforeRow.id === afterRow.id && beforeRow.kind === afterRow.kind;
    }
    return true;
  }
  // A map row's index is a viewport position: the map re-centres, and the same
  // row shows a different node. Take clicks carry an index, so they are proved
  // by the row it named, the way map focus already is.
  if (before.index !== undefined
    && (beforeState.mode === "MAP" || afterState.mode === "MAP")) {
    const row = mapRowId(beforeState, before.index);
    if (row === null || row !== mapRowId(afterState, after.index)) return false;
  }
  // A gesture that names no cell acts on whatever holds focus, so the focused
  // part is its identity. `continue` clicked while reading one part must not
  // generate from another because focus moved before its turn came.
  if (before.index === undefined && before.rowId === undefined
    && focusedPartId(beforeState) !== focusedPartId(afterState)) {
    return false;
  }
  return before.index === after.index
    && before.rowId === after.rowId
    && before.take === after.take
    && before.view === after.view
    && before.settingsRow === after.settingsRow
    && before.text === after.text;
}

function mapRowAt(
  state: MouseActionState,
  event: FrozenMouseEvent
): { id: string; kind: "node" | "sketch" | "cold" } | null {
  const target = hitAt(state.hitRows, event.x, event.y);
  return target?.kind === "list" ? target.mapRow ?? null : null;
}

function mapRowId(state: MouseActionState, index: number | undefined): string | null {
  return index === undefined ? null : state.map?.rowIds[index] ?? null;
}

/** The part a focus-relative gesture would act on. */
function focusedPartId(state: MouseActionState): string | null {
  return rowPart(createStoryViewModel(state.payload, state.stream), state.focusIndex)?.id ?? null;
}

function selectedListIdentity(state: MouseActionState): string | null {
  if (state.mode === "MAP" && state.map !== null) {
    const id = state.map.view === "path" ? state.map.pathCursorId : state.map.treeCursorId;
    return id === null ? null : `map:${state.map.view}:${id}`;
  }
  // Name the verb, not its position: the menu's entries change composition
  // while a generation lands, so the row under an unmoved cursor can become a
  // different — and destructive — action.
  if (state.actions !== null) {
    const entry = currentPartActions(state)[state.actions.cursor];
    return entry === undefined ? null : `actions:${state.actions.partId}:${entry.id}`;
  }
  if (state.library !== null) {
    const story = libraryRows(state.library.stories, state.library.query)[state.library.cursor];
    return story === undefined ? null : `library:${story.id}`;
  }
  if (state.commands !== null) {
    return `commands:${state.commands.view}:${state.commands.selectedId ?? state.commands.cursor}`;
  }
  if (state.facts !== null) {
    const fact = factRows(state.payload.facts, state.facts.selectedTag, state.facts.query)[
      state.facts.cursor
    ];
    return fact === undefined ? null : `facts:${fact.id}`;
  }
  if (state.chapters !== null) {
    const chapter = createStoryViewModel(state.payload).chapters[state.chapters.cursor];
    return chapter === undefined
      ? null
      : `chapters:${chapter.openingBreakId ?? "first"}`;
  }
  if (state.settings !== null) {
    const row = SETTINGS_ROW_IDS[state.settings.cursor];
    return row === undefined ? null : `settings:${row}`;
  }
  return null;
}

function relativeMouseAction(action: ResolvedKey): boolean {
  return action.action === "scroll-down" || action.action === "scroll-up"
    || action.action === "focus-next" || action.action === "focus-previous";
}
