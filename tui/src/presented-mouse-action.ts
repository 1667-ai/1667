import type { MouseEvent } from "@opentui/core";
import { hitAt } from "./hit.js";
import type { ResolvedKey } from "./keys.js";
import { factRows } from "./facts-model.js";
import { commandContext, commandMatches, commandSelectionId } from "./command-model.js";
import { libraryRows } from "./library-model.js";
import { currentPartActions } from "./story-actions.js";
import { createStoryIndex } from "../../shared/story-model.js";
import { childrenOf, nodeById } from "../../shared/story-tree.js";
import { createStoryViewModel, rowPart } from "./model.js";
import { SETTINGS_ROW_IDS } from "./settings-overlay-model.js";
import {
  mouseToAction,
  overlayOpen,
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
  if (action.action === "edit" && action.rowId !== undefined && state.facts !== null) {
    const index = factRows(
      state.payload.facts,
      state.facts.selectedTag,
      state.facts.query
    ).findIndex((fact) => fact.id === action.rowId);
    return index < 0 ? null : { ...action, index };
  }
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
    // A list row's index is a position: the rows are derived, and a menu's
    // entries change composition while a generation lands.
    if (overlayOpen(beforeState) && beforeState.mode !== "MAP") {
      const row = listRowIdentity(beforeState, before.index);
      return row !== null && row === listRowIdentity(afterState, after.index);
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
  // A take ordinal is a position among siblings: prune one and the same
  // number names a different node. Prove the node, not the count.
  if (before.take !== undefined) {
    const sibling = takeNodeId(beforeState, before);
    if (sibling === null || sibling !== takeNodeId(afterState, after)) return false;
  }
  // A gesture that names no cell acts on a selection — the open surface's
  // chosen row, or the focused part when the story has the screen — so the
  // selection is its identity. `continue` must not generate from a part focus
  // moved to, and a menu's `↵ run` must not run a verb that replaced the one
  // under the cursor. An identity that cannot be resolved refuses.
  if (before.index === undefined && before.rowId === undefined) {
    const selection = selectionIdentity(beforeState);
    if (selection === null || selection !== selectionIdentity(afterState)) return false;
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

/** The sibling a one-based take ordinal names, under the row the gesture
 *  landed on. The map names that row by index; the story uses its focus. */
function takeNodeId(state: MouseActionState, action: ResolvedKey): string | null {
  if (action.take === undefined) return null;
  const view = createStoryViewModel(state.payload, state.stream);
  const anchor = state.mode === "MAP"
    ? mapRowId(state, action.index)
    : rowPart(view, action.index ?? state.focusIndex)?.id ?? null;
  if (anchor === null) return null;
  const index = createStoryIndex(state.payload);
  const node = nodeById(index.tree, anchor);
  if (node === null) return null;
  return childrenOf(index.tree, node.parentId)[action.take - 1]?.id ?? null;
}

function mapRowId(state: MouseActionState, index: number | undefined): string | null {
  return index === undefined ? null : state.map?.rowIds[index] ?? null;
}

/** The row an index named, for surfaces whose rows are derived and can be
 *  reordered, inserted into or re-centred between one frame and the next.
 *  Null means the row cannot be named, which reconciliation refuses. */
function listRowIdentity(state: MouseActionState, index: number | undefined): string | null {
  if (index === undefined) return null;
  if (state.mode === "MAP" && state.map !== null) return mapRowId(state, index);
  if (state.actions !== null) return currentPartActions(state)[index]?.id ?? null;
  if (state.library !== null) {
    return libraryRows(state.library.stories, state.library.query)[index]?.id ?? null;
  }
  if (state.commands !== null) {
    if (state.commands.view === "tags") {
      return state.payload.tags[index]?.nodeId ?? null;
    }
    const match = commandMatches(
      state.commands.query,
      state.demo,
      commandContext(state.payload, state.connection.down, state.requestActive ?? false)
    )[index];
    return match === undefined ? null : commandSelectionId(match.command);
  }
  if (state.facts !== null) {
    return factRows(state.payload.facts, state.facts.selectedTag, state.facts.query)[index]?.id
      ?? null;
  }
  if (state.chapters !== null) {
    const chapter = createStoryViewModel(state.payload).chapters[index];
    return chapter === undefined ? null : `chapter:${chapter.openingBreakId ?? "first"}`;
  }
  if (state.settings !== null) return SETTINGS_ROW_IDS[index] ?? null;
  return null;
}

/** What an action that names no cell acts on. An overlay owns its own
 *  selection; otherwise the story's focused part is the target. Null means the
 *  selection cannot be named, which reconciliation treats as a refusal. */
function selectionIdentity(state: MouseActionState): string | null {
  const selected = selectedListIdentity(state);
  if (selected !== null) return selected;
  // A surface with rows but no nameable selection refuses. One with no rows at
  // all — the key reference, a summary, the scrim behind them — has nothing to
  // move, so `esc`, `retry` and the global opens stay clickable.
  if (selectableRowsOpen(state)) return null;
  return createStoryViewModel(state.payload, state.stream).rows[state.focusIndex]?.id
    ?? NO_SELECTION;
}

const NO_SELECTION = "none";

/** Whether the open surface has rows a click could land on the wrong one of. */
function selectableRowsOpen(state: MouseActionState): boolean {
  return state.map !== null || state.actions !== null || state.library !== null
    || state.facts !== null || state.commands !== null || state.chapters !== null
    || state.settings !== null;
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
    // The tags view keeps the id of the command that opened it, so it
    // says nothing about which tag the cursor is on — and `d` deletes
    // whichever that is.
    if (state.commands.view === "tags") {
      const tag = state.payload.tags[state.commands.cursor];
      return tag === undefined ? null : `tags:${tag.nodeId}`;
    }
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
