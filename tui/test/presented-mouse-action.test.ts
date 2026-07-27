import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createStoryIndex } from "../../shared/story-model.js";
import { childrenOf, nodeById } from "../../shared/story-tree.js";
import { rowIndexForNode } from "../src/model.js";
import { currentPartActions } from "../src/story-actions.js";
import { mouseToAction, captureMouseActionState } from "../src/mouse-actions.js";
import {
  canCapturePresentedMouseAction,
  reconcilePresentedMouseAction,
  type FrozenMouseEvent,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";
import { createStoryViewModel } from "../src/model.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";

type State = ReturnType<typeof initialState>;

const click: FrozenMouseEvent = {
  type: "down",
  button: 0,
  x: 4,
  y: 0,
  modifiers: { shift: false, alt: false, ctrl: false }
};

function interaction(state: State, version: number): PresentedInteraction {
  return {
    version,
    frameToken: version,
    interactive: true,
    storyId: state.payload.id,
    state: captureMouseActionState(state)
  };
}

function reconcile(
  state: State,
  action: NonNullable<ReturnType<typeof mouseToAction>>,
  captured: PresentedInteraction,
  presented: PresentedInteraction
) {
  return reconcilePresentedMouseAction({ action, event: click, captured, presented, state });
}

function showMap(state: State, cursorId: string, rowIds: string[]): void {
  state.mode = "MAP";
  state.map = {
    view: "path",
    pathCursorId: cursorId,
    treeCursorId: cursorId,
    rowIds,
    pathShowAllTakes: true,
    showSketches: false,
    openedColdFolds: new Set(),
    massSort: "size"
  };
}

describe("presented mouse reconciliation", () => {
  test("rejects the old interaction owner while a partial frame is failed", () => {
    const state = initialState(demoAppSource(), false);
    const presented = interaction(state, 7);

    expect(canCapturePresentedMouseAction(presented, false)).toBeTrue();
    expect(canCapturePresentedMouseAction(presented, true)).toBeFalse();
    expect(canCapturePresentedMouseAction(
      { ...presented, interactive: false }, false
    )).toBeFalse();
  });

  test("re-resolves animation-only prose movement by stable row identity", () => {
    const state = initialState(demoAppSource(), false);
    state.hitRows = [{ target: { kind: "part", index: 3, rowId: "part-a" }, left: 0, right: 20 }];
    const captured = interaction(state, 7);
    const action = mouseToAction(click as never, captured.state)!;

    state.hitRows = [{ target: { kind: "part", index: 8, rowId: "part-a" }, left: 0, right: 20 }];
    const moved = interaction(state, 7);
    expect(reconcile(state, action, captured, moved))
      .toEqual({ action: "focus-index", index: 8, rowId: "part-a" });

    state.hitRows = [{ target: { kind: "part", index: 8, rowId: "part-b" }, left: 0, right: 20 }];
    expect(reconcile(state, action, captured, interaction(state, 7))).toBe(null);
  });

  test("proves map row and cursor identities after animation-only folding", () => {
    const state = initialState(demoAppSource(), false);
    showMap(state, "cursor", ["cursor", "target"]);
    state.hitRows = [{ target: { kind: "list", index: 1 }, left: 0, right: 20 }];
    const captured = interaction(state, 11);
    const focusTarget = mouseToAction(click as never, captured.state)!;
    expect(focusTarget).toEqual({ action: "focus-index", index: 1 });

    showMap(state, "cursor", ["cursor", "revealed", "target"]);
    state.hitRows = [{ target: { kind: "list", index: 2 }, left: 0, right: 20 }];
    expect(reconcile(state, focusTarget, captured, interaction(state, 11)))
      .toEqual({ action: "focus-index", index: 2 });

    showMap(state, "cursor", ["cursor", "revealed", "replacement"]);
    expect(reconcile(state, focusTarget, captured, interaction(state, 11))).toBe(null);

    showMap(state, "cursor", ["cursor", "target"]);
    state.hitRows = [{ target: { kind: "list", index: 0 }, left: 0, right: 20 }];
    const selectedFrame = interaction(state, 11);
    const openSelected = mouseToAction(click as never, selectedFrame.state)!;
    expect(openSelected).toEqual({ action: "open-selected" });

    showMap(state, "cursor", ["revealed", "cursor"]);
    state.hitRows = [{ target: { kind: "list", index: 1 }, left: 0, right: 20 }];
    expect(reconcile(state, openSelected, selectedFrame, interaction(state, 11)))
      .toEqual({ action: "open-selected" });

    showMap(state, "replacement", ["revealed", "replacement"]);
    expect(reconcile(state, openSelected, selectedFrame, interaction(state, 11))).toBe(null);
  });

  test("proves the selected Settings row across animation-only repaint", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.cursor = 2;
    state.hitRows = [{
      target: { kind: "list", index: 2, selected: true },
      left: 0,
      right: 20
    }];
    const captured = interaction(state, 13);
    const openSelected = mouseToAction(click, captured.state)!;
    expect(openSelected).toEqual({ action: "open-selected" });

    expect(reconcile(state, openSelected, captured, interaction(state, 13)))
      .toEqual({ action: "open-selected" });
    state.settings.cursor = 3;
    expect(reconcile(state, openSelected, captured, interaction(state, 13))).toBe(null);
  });

  test("discards selected tree activation when one cursor ID changes node/cold semantics", () => {
    const state = initialState(demoAppSource(), false);
    showMap(state, "cursor", ["cursor"]);
    state.map!.view = "tree";

    for (const [beforeKind, afterKind] of [
      ["node", "cold"],
      ["cold", "node"]
    ] as const) {
      state.hitRows = [{
        target: { kind: "list", index: 0, mapRow: { id: "cursor", kind: beforeKind } },
        left: 0,
        right: 20
      }];
      const captured = interaction(state, 12);
      const openSelected = mouseToAction(click, captured.state)!;
      expect(openSelected).toEqual({ action: "open-selected" });
      expect(reconcile(state, openSelected, captured, interaction(state, 12)))
        .toEqual({ action: "open-selected" });

      state.hitRows = [{
        target: { kind: "list", index: 0, mapRow: { id: "cursor", kind: afterKind } },
        left: 0,
        right: 20
      }];
      expect(reconcile(state, openSelected, captured, interaction(state, 12))).toBe(null);
    }
  });

  test("requires the same resolved action target after a paint-only frame", () => {
    const state = initialState(demoAppSource(), false);
    state.hitRows = [{ target: { kind: "action", action: "retry" }, left: 0, right: 20 }];
    const captured = interaction(state, 3);
    const retry = mouseToAction(click as never, captured.state)!;

    state.hitRows = [{ target: { kind: "action", action: "retry" }, left: 0, right: 20 }];
    expect(reconcile(state, retry, captured, interaction(state, 3))).toEqual({ action: "retry" });

    state.hitRows = [{ target: { kind: "action", action: "cancel" }, left: 0, right: 20 }];
    expect(reconcile(state, retry, captured, interaction(state, 3))).toBe(null);
  });

  test("retains right-click selection metadata after animation-only drift", () => {
    const state = initialState(demoAppSource(), false);
    state.hitRows = [{
      target: { kind: "part", index: 3, rowId: "part-a" },
      left: 0,
      right: 20
    }];
    const rightClick = { ...click, button: 2 };
    const captured = interaction(state, 9);
    const action = {
      ...mouseToAction(rightClick, captured.state)!,
      selectionText: "selected prose",
      selectionSpans: [{
        key: "part-a:text",
        text: "selected prose remains visible",
        start: 0,
        end: 14
      }]
    };

    expect(reconcilePresentedMouseAction({
      action,
      event: rightClick,
      captured,
      presented: interaction(state, 9),
      state
    })).toEqual(action);
  });

  test("delivers a control clicked while a repaint was pending", () => {
    // The queue flushes a pending repaint before running the click, so the
    // frame it lands on is one version past the one it was captured against.
    // Nothing moved: the control is still under the pointer, so the click has
    // to count. Dropping these is why clicking felt unreliable under load.
    const state = initialState(demoAppSource(), false);
    state.hitRows = [{ target: { kind: "action", action: "open-map" }, left: 0, right: 20 }];
    const captured = interaction(state, 20);
    const rebuilt = interaction(state, 21);
    const resolved = mouseToAction(click, state, false)!;

    expect(resolved.action).toBe("open-map");
    expect(reconcile(state, resolved, captured, rebuilt)).toEqual({ action: "open-map" });

    // …and it still refuses when the control is no longer what it names.
    state.hitRows = [{ target: { kind: "action", action: "open-facts" }, left: 0, right: 20 }];
    expect(reconcile(state, resolved, captured, interaction(state, 21))).toBe(null);
  });

  test("refuses a right-click whose part moved out from under it", () => {
    // Rows shift when a part lands or is pruned above. An index alone would
    // open the menu on whatever now occupies that row.
    const state = initialState(demoAppSource(), false);
    const clicked = state.payload.path.at(-2)!.id;
    state.hitRows = [{ target: { kind: "part", index: 4, rowId: clicked }, left: 0, right: 20 }];
    const captured = interaction(state, 20);
    const resolved = mouseToAction({ ...click, button: 2 }, state, false)!;
    expect(resolved.action).toBe("open-actions");

    state.hitRows = [{
      target: { kind: "part", index: 4, rowId: state.payload.path.at(-1)!.id },
      left: 0,
      right: 20
    }];
    const rebuilt = interaction(state, 21);
    expect(reconcilePresentedMouseAction({
      action: resolved, event: { ...click, button: 2 },
      captured, presented: rebuilt, state
    })).toBe(null);
  });

  test("refuses a menu click when the entry under the cursor became another verb", () => {
    // The part menu stays open while a generation lands, and landing adds
    // prune and tag to the list. The cursor does not move; the verb
    // beneath it does.
    const state = initialState(demoAppSource(), false);
    const leaf = state.payload.path.at(-1)!;
    state.hitRows = [{ target: { kind: "list", index: 5, selected: true }, left: 0, right: 20 }];
    state.actions = { cursor: 5, partId: leaf.id };
    state.stream = null;

    const unpersisted = {
      ...state,
      payload: { ...state.payload, nodes: state.payload.nodes.filter(({ id }) => id !== leaf.id) }
    };
    const captured = interaction(unpersisted as typeof state, 20);
    const resolved = mouseToAction(click, unpersisted as typeof state, false)!;
    expect(resolved.action).toBe("open-selected");

    const landed = interaction(state, 21);
    expect(currentPartActions(unpersisted as typeof state)[5]?.id)
      .not.toBe(currentPartActions(state)[5]?.id);
    expect(reconcilePresentedMouseAction({
      action: resolved, event: click, captured, presented: landed, state
    })).toBe(null);
  });

  test("refuses a focus-relative control once focus has moved", () => {
    // The status line's verbs name no cell — they act on whatever holds focus.
    // Clicking `continue` while reading one part must not generate from
    // another because focus moved before the click's turn came.
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.hitRows = [{ target: { kind: "action", action: "continue" }, left: 0, right: 20 }];
    const captured = interaction(state, 20);
    const resolved = mouseToAction(click, state, false)!;
    expect(resolved).toEqual({ action: "continue" });

    expect(reconcile(state, resolved, captured, interaction(state, 21)))
      .toEqual({ action: "continue" });

    state.focusIndex = 3;
    expect(reconcile(state, resolved, captured, interaction(state, 21))).toBe(null);
  });

  test("refuses a map take click when its row now shows another node", () => {
    // A map row index is a viewport position. The map re-centres, and the row
    // the click named holds a different node — rerouting there would follow a
    // branch the writer never pointed at.
    const state = initialState(demoAppSource(), false);
    const ids = state.payload.path.map((node) => node.id);
    showMap(state, ids[0]!, [...ids]);
    state.hitRows = [{ target: { kind: "take", row: 2, take: 1 }, left: 0, right: 20 }];
    const captured = interaction(state, 20);
    const resolved = mouseToAction(click, state, false)!;
    expect(resolved).toEqual({ action: "apply", index: 2, take: 1 });

    expect(reconcile(state, resolved, captured, interaction(state, 21)))
      .toEqual({ action: "apply", index: 2, take: 1 });

    state.map!.rowIds = ids.slice(3);
    expect(reconcile(state, resolved, captured, interaction(state, 21))).toBe(null);
  });

  test("refuses a menu footer click when the verb under the cursor changed", () => {
    // `↵ run` names no cell — it runs whatever the menu cursor is on. A
    // selection appearing inserts an entry above the cursor, so the same
    // position becomes a different verb while the part stays the same.
    const base = initialState(demoAppSource(), false);
    base.stream = null;
    base.mode = "ACTIONS";
    base.hitRows = [{ target: { kind: "action", action: "apply" }, left: 0, right: 20 }];
    const partId = base.payload.path.at(-1)!.id;
    const selecting = { ...base, actions: { cursor: 7, partId, selectionText: "prose" } } as State;
    const plain = { ...base, actions: { cursor: 7, partId } } as State;
    expect(currentPartActions(selecting)[7]?.id).not.toBe(currentPartActions(plain)[7]?.id);

    const resolved = mouseToAction(click, selecting, false)!;
    expect(resolved).toEqual({ action: "apply" });
    const captured = interaction(selecting, 20);

    expect(reconcile(selecting, resolved, captured, interaction(selecting, 21)))
      .toEqual({ action: "apply" });
    expect(reconcile(plain, resolved, captured, interaction(plain, 21))).toBe(null);
  });

  test("refuses a tag delete once the cursor has moved to another one", () => {
    // The tags view keeps the id of the command that opened it, so it
    // cannot say which tag is selected. `d` deletes whichever the cursor
    // is on, so the tag itself has to be the identity.
    const base = initialState(demoAppSource(), false);
    base.stream = null;
    base.mode = "COMMANDS";
    base.hitRows = [{ target: { kind: "action", action: "delete-item" }, left: 0, right: 20 }];
    expect(base.payload.tags.length).toBeGreaterThan(1);
    const at = (cursor: number) => ({
      ...base,
      commands: { query: "", cursor, selectedId: "tags", view: "tags" }
    }) as State;

    const resolved = mouseToAction(click, at(0), false)!;
    expect(resolved).toEqual({ action: "delete-item" });
    const captured = interaction(at(0), 20);

    expect(reconcile(at(0), resolved, captured, interaction(at(0), 21)))
      .toEqual({ action: "delete-item" });
    expect(reconcile(at(1), resolved, captured, interaction(at(1), 21))).toBe(null);
  });

  test("refuses a list row click once that row holds another entry", () => {
    // Clicking an unselected menu row only moves the cursor, but onto whatever
    // that row holds now. A selection appearing shifts the entries beneath it.
    const base = initialState(demoAppSource(), false);
    base.stream = null;
    base.mode = "ACTIONS";
    base.hitRows = [{ target: { kind: "list", index: 7 }, left: 0, right: 20 }];
    const partId = base.payload.path.at(-1)!.id;
    const selecting = { ...base, actions: { cursor: 0, partId, selectionText: "prose" } } as State;
    const plain = { ...base, actions: { cursor: 0, partId } } as State;
    expect(currentPartActions(selecting)[7]?.id).not.toBe(currentPartActions(plain)[7]?.id);

    const resolved = mouseToAction(click, selecting, false)!;
    expect(resolved).toEqual({ action: "focus-index", index: 7 });
    const captured = interaction(selecting, 20);

    expect(reconcile(selecting, resolved, captured, interaction(selecting, 21)))
      .toEqual({ action: "focus-index", index: 7 });
    expect(reconcile(plain, resolved, captured, interaction(plain, 21))).toBe(null);
  });

  test("keeps clicking usable where a surface has no selection to move", () => {
    // Tightening identity must not start dropping the clicks this set out to
    // deliver. The key reference has no rows, so the scrim's `cancel` — the
    // documented way to close a panel — survives a repaint.
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "KEYS";
    state.hitRows = [{ target: { kind: "scrim" }, left: 0, right: 20 }];
    const resolved = mouseToAction(click, state, false)!;
    expect(resolved).toEqual({ action: "cancel" });
    expect(reconcile(state, resolved, interaction(state, 20), interaction(state, 21)))
      .toEqual({ action: "cancel" });
  });

  test("delivers a command row that has not moved", () => {
    // Command rows are nameable, so a repaint must not discard them the way an
    // unnameable row is discarded.
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    state.mode = "COMMANDS";
    state.commands = { query: "", cursor: 0, selectedId: null, view: "commands" };
    state.hitRows = [{ target: { kind: "list", index: 3 }, left: 0, right: 20 }];
    const resolved = mouseToAction(click, state, false)!;
    expect(resolved).toEqual({ action: "focus-index", index: 3 });
    expect(reconcile(state, resolved, interaction(state, 20), interaction(state, 21)))
      .toEqual({ action: "focus-index", index: 3 });

    // …and still refuses when that row now holds a different command.
    const filtered = { ...state, commands: { ...state.commands, query: "theme" } } as State;
    expect(reconcile(filtered, resolved, interaction(state, 20), interaction(filtered, 21)))
      .toBe(null);
  });

  test("refuses a take click once that ordinal names another sibling", () => {
    // `‹ take 2/5 ›` is a position among siblings. Prune an earlier one and
    // the same number switches the line to a different node.
    const state = initialState(demoAppSource(), false);
    state.stream = null;
    const focused = state.payload.path.at(-2)!;
    state.focusIndex = rowIndexForNode(createStoryViewModel(state.payload), focused.id);
    const index = createStoryIndex(state.payload);
    const siblings = childrenOf(index.tree, nodeById(index.tree, focused.id)!.parentId);
    expect(siblings.length).toBeGreaterThan(2);
    state.hitRows = [{ target: { kind: "story-take", take: 2 }, left: 0, right: 20 }];

    const resolved = mouseToAction(click, state, false)!;
    expect(resolved).toEqual({ action: "take-at", take: 2 });
    const captured = interaction(state, 20);
    expect(reconcile(state, resolved, captured, interaction(state, 21)))
      .toEqual({ action: "take-at", take: 2 });

    state.payload = {
      ...state.payload,
      nodes: state.payload.nodes.filter((node) => node.id !== siblings[0]!.id)
    };
    expect(reconcile(state, resolved, captured, interaction(state, 21))).toBe(null);
  });

  test("retains stable-prose and relative-only policy after semantic drift", () => {
    const state = initialState(demoAppSource(), false);
    const rowId = state.payload.path.at(-1)!.id;
    state.hitRows = [{ target: { kind: "part", index: 0, rowId }, left: 0, right: 20 }];
    const captured = interaction(state, 20);
    const current = interaction(state, 21);
    const expectedIndex = createStoryViewModel(state.payload).rows
      .findIndex((row) => row.id === rowId);

    expect(reconcile(state, { action: "focus-index", index: 0, rowId }, captured, current))
      .toEqual({ action: "focus-index", index: expectedIndex, rowId });
    expect(reconcile(state, { action: "scroll-down" }, captured, current))
      .toEqual({ action: "scroll-down" });
    expect(reconcile(state, { action: "focus-index", index: 0 }, captured, current))
      .toBe(null);
  });
});
