import { describe, expect, test } from "bun:test";
import { dispatch, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createInteractiveInputAdmission } from "../src/interactive-input-admission.js";
import { captureMouseActionState } from "../src/mouse-actions.js";
import { createStoryViewModel } from "../src/model.js";
import { createPresentedInputQueue } from "../src/presented-input-queue.js";
import {
  reconcilePresentedMouseAction,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

type PartClick = {
  type: "down" | "up";
  button: number;
  x: number;
  y: number;
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean };
};

describe("take double-click through interactive input admission", () => {
  test("opens manual edit for the exact take body", async () => {
    let now = 1_000;
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    const wrapCache = createWrapCache<ProseStyle>();
    Object.assign(state, renderStoryScreen(state, {
      width: 120,
      height: 12,
      wrapCache
    }).derived);
    const located = state.hitRows
      .map((hit, y) => ({ hit, y }))
      .find(({ hit }) => hit?.target.kind === "part"
        && hit.target.index !== state.focusIndex);
    if (located?.hit?.target.kind !== "part") throw new Error("missing take body hit");
    const target = located.hit.target;
    const x = Math.max(located.hit.left, located.hit.right - 2);
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const admission = createInteractiveInputAdmission({ now: () => now });
    let version = 0;
    let runs = 0;
    const enqueue = async (type: PartClick["type"]) => {
      Object.assign(state, renderStoryScreen(state, {
        width: 120,
        height: 12,
        wrapCache
      }).derived);
      version += 1;
      const presented: PresentedInteraction = {
        version,
        frameToken: version,
        interactive: true,
        storyId: state.payload.id,
        state: captureMouseActionState(state)
      };
      admission.enqueueMouse(queue, {
        type,
        button: 0,
        x,
        y: located.y,
        modifiers: { shift: false, alt: false, ctrl: false }
      }, {
        presented,
        frameFailed: false,
        requestInputRecovery() {},
        run: (action, event, captured) => {
          runs += 1;
          const reconciled = reconcilePresentedMouseAction({
            action,
            event,
            captured,
            presented,
            state
          });
          if (reconciled === null) return;
          return dispatch(
            reconciled,
            state,
            source,
            wrapCache,
            () => undefined,
            async () => undefined,
            () => undefined
          );
        }
      });
      for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
    };

    await enqueue("down");
    await enqueue("up");
    expect(runs).toBe(1);
    Object.assign(state, renderStoryScreen(state, {
      width: 120,
      height: 12,
      wrapCache
    }).derived);
    expect(state.hitRows[located.y]?.target).not.toMatchObject({ rowId: target.rowId });
    now += 120;
    await enqueue("down");
    expect(runs).toBe(1);
    await enqueue("up");
    expect(runs).toBe(2);

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("document");
    if (state.editor?.kind !== "document") throw new Error("manual editor did not open");
    expect(state.editor.target).toMatchObject({ kind: "part", node: { id: target.rowId } });
  });

  test("does not open manual edit for a chapter row", async () => {
    let now = 1_000;
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    const wrapCache = createWrapCache<ProseStyle>();
    const rows = renderStoryScreen(state, {
      width: 120,
      height: 80,
      wrapCache
    }).derived;
    Object.assign(state, rows);
    const viewRows = createStoryViewModel(state.payload).rows;
    const located = state.hitRows
      .map((hit, y) => ({ hit, y }))
      .find(({ hit }) => hit?.target.kind === "part"
        && viewRows[hit.target.index]?.kind !== "part");
    if (located?.hit?.target.kind !== "part") throw new Error("missing chapter row hit");
    const x = Math.max(located.hit.left, located.hit.right - 2);
    const presented: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const admission = createInteractiveInputAdmission({ now: () => now });
    const enqueue = (type: PartClick["type"]) => admission.enqueueMouse(queue, {
      type,
      button: 0,
      x,
      y: located.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    }, {
      presented,
      frameFailed: false,
      requestInputRecovery() {},
      run: (action, event, captured) => {
        const reconciled = reconcilePresentedMouseAction({
          action,
          event,
          captured,
          presented,
          state
        });
        if (reconciled === null) return;
        return dispatch(
          reconciled,
          state,
          source,
          wrapCache,
          () => undefined,
          async () => undefined,
          () => undefined
        );
      }
    });

    enqueue("down");
    enqueue("up");
    now += 120;
    enqueue("down");
    enqueue("up");
    for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();

    expect(state.mode).toBe("NAV");
    expect(state.editor).toBe(null);
  });
});
