import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
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
  presented: PresentedInteraction,
  version = presented.version
) {
  return reconcilePresentedMouseAction({
    action,
    event: click,
    captured,
    presented,
    currentVersion: version,
    state
  });
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
      currentVersion: 9,
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
