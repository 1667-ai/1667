import { describe, expect, test } from "bun:test";
import { dispatch, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { createInteractiveInputAdmission } from "../src/interactive-input-admission.js";
import {
  captureMouseActionState,
  createFactDoubleClickGate,
  mouseToAction
} from "../src/mouse-actions.js";
import { createPresentedInputQueue } from "../src/presented-input-queue.js";
import {
  reconcilePresentedMouseAction,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";
import { renderStoryScreen } from "../src/screens/story.js";
import type { RuntimeState } from "../src/state.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

type FactClick = {
  type: "down";
  button: number;
  x: number;
  y: number;
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean };
};

/** Production admission boundary for Facts: gates, queue, reconcile, dispatch. */
function createFactsAdmission(options: {
  now?: () => number;
  ready?: () => boolean;
} = {}) {
  const source = demoAppSource();
  const state = initialState(source, false);
  state.mode = "FACTS";
  state.facts = {
    cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null
  };
  const wrapCache = createWrapCache<ProseStyle>();
  const rendered = renderStoryScreen(state, { width: 120, height: 30, wrapCache });
  Object.assign(state, rendered.derived);
  const presented: PresentedInteraction = {
    version: 1,
    frameToken: 1,
    interactive: true,
    storyId: state.payload.id,
    state: captureMouseActionState(state)
  };
  const queue = createPresentedInputQueue({
    flush() {},
    ready: options.ready ?? (() => true)
  });
  const admission = createInteractiveInputAdmission({ now: options.now });
  const enqueueMouse = (event: FactClick, onAction?: (action: string) => void) => {
    admission.enqueueMouse(queue, event, {
      presented,
      frameFailed: false,
      requestInputRecovery() {},
      run: (action, queuedEvent, captured) => {
        const reconciled = reconcilePresentedMouseAction({
          action, event: queuedEvent, captured, presented, state
        });
        if (reconciled === null) return;
        onAction?.(reconciled.action);
        return dispatch(
          reconciled, state, source, wrapCache,
          () => undefined, async () => undefined, () => undefined
        );
      }
    });
  };
  const enqueueText = (run: () => void | Promise<void>) => {
    admission.enqueueText(queue, run);
  };
  return { source, state, presented, queue, admission, enqueueMouse, enqueueText };
}

function factClick(
  state: RuntimeState,
  index: number,
  options: { shift?: boolean } = {}
): FactClick {
  const located = state.hitRows.flatMap((row, y) => row === null
    ? []
    : [row, ...row.overrides ?? []].map((hit) => ({ hit, y })))
    .find(({ hit }) => hit.target.kind === "list" && hit.target.index === index);
  if (located === undefined) throw new Error(`missing fact list hit ${index}`);
  return {
    type: "down",
    button: 0,
    x: located.hit.left + 2,
    y: located.y,
    modifiers: { shift: options.shift === true, alt: false, ctrl: false }
  };
}

async function drainMicrotasks(turns = 16): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function factsPanelState(): RuntimeState {
  const state = initialState(demoAppSource(), false);
  state.mode = "FACTS";
  state.facts = {
    cursor: 0, query: "", chip: 0, selectedTag: null, filtering: false, deleteArmedId: null
  };
  Object.assign(state, renderStoryScreen(state, {
    width: 120, height: 30, wrapCache: createWrapCache()
  }).derived);
  return state;
}

describe("Fact double-click through interactive input admission", () => {
  test("uninterrupted double-click opens the exact Fact editor", async () => {
    let now = 1_000;
    const { source, state, enqueueMouse } = createFactsAdmission({ now: () => now });
    const factId = source.payload.facts[0]!.id;
    const event = factClick(state, 0);

    enqueueMouse(event);
    now += 120;
    enqueueMouse(event);
    await drainMicrotasks();

    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.target).toMatchObject({ kind: "fact", factId });
  });

  test("first click + queued keyboard + second click does not edit", async () => {
    let now = 1_000;
    let ready = true;
    const order: string[] = [];
    const { state, enqueueMouse, enqueueText, queue } = createFactsAdmission({
      now: () => now,
      ready: () => ready
    });
    const event = factClick(state, 0);

    // First click arms the incomplete double-click pair immediately.
    enqueueMouse(event, (action) => order.push(`mouse:${action}`));
    // Block presentation so the key and second click stay queued.
    ready = false;
    enqueueText(() => { order.push("key"); });
    now += 50;
    // Second click while the key is still blocked cannot complete the pair.
    enqueueMouse(event, (action) => order.push(`mouse:${action}`));

    ready = true;
    queue.presented();
    await drainMicrotasks();

    expect(order[0]).toBe("key");
    expect(order.some((step) => step === "mouse:edit")).toBeFalse();
    expect(state.mode).toBe("FACTS");
    expect(state.editor).toBe(null);
  });

  test("queued completed click before Enter preserves FIFO and opens the selected Fact", async () => {
    let ready = false;
    const order: string[] = [];
    const { source, state, enqueueMouse, enqueueText, queue } = createFactsAdmission({
      ready: () => ready
    });
    const otherId = source.payload.facts[1]!.id;
    const wrapCache = createWrapCache<ProseStyle>();

    // Completed single click on another Fact is enqueued first.
    enqueueMouse(factClick(state, 1), () => order.push("mouse"));
    // Enter is second; interrupt clears incomplete gates only.
    enqueueText(async () => {
      order.push("key");
      expect(state.facts!.cursor).toBe(1);
      await dispatch(
        { action: "edit" }, state, source, wrapCache,
        () => undefined, async () => undefined, () => undefined
      );
    });
    expect(order).toEqual([]);

    ready = true;
    queue.presented();
    await drainMicrotasks();

    expect(order).toEqual(["mouse", "key"]);
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.target).toMatchObject({ kind: "fact", factId: otherId });
  });
});

describe("Fact double-click gate (isolated)", () => {
  test("drag and scroll cancel without text admission", () => {
    const state = factsPanelState();
    let now = 1_000;
    const event = factClick(state, 0);
    for (const interruption of ["drag", "scroll"] as const) {
      const gate = createFactDoubleClickGate(() => now);
      expect(gate.resolve(event as never, mouseToAction(event as never, state), state)).toBe(null);
      gate.resolve({
        type: interruption,
        button: 0,
        x: event.x,
        y: event.y,
        modifiers: { shift: false, alt: false, ctrl: false }
      } as never, null, state);
      now += 120;
      expect(gate.resolve(event as never, mouseToAction(event as never, state), state)).toBe(null);
    }
  });

  test("two Shift-clicks on a Fact never open the editor", () => {
    const state = factsPanelState();
    let now = 1_000;
    const gate = createFactDoubleClickGate(() => now);
    const shiftClick = factClick(state, 0, { shift: true });

    expect(mouseToAction(shiftClick as never, state)).toBe(null);
    expect(gate.resolve(shiftClick as never, mouseToAction(shiftClick as never, state), state)).toBe(null);
    now += 120;
    expect(gate.resolve(shiftClick as never, mouseToAction(shiftClick as never, state), state)).toBe(null);
  });

  test("a normal Fact click then a Shift-click does not open the editor", () => {
    const state = factsPanelState();
    let now = 1_000;
    const gate = createFactDoubleClickGate(() => now);
    const normal = factClick(state, 0);
    const shiftClick = factClick(state, 0, { shift: true });

    expect(gate.resolve(normal as never, mouseToAction(normal as never, state), state)).toBe(null);
    now += 120;
    expect(gate.resolve(shiftClick as never, mouseToAction(shiftClick as never, state), state)).toBe(null);
    now += 120;
    expect(gate.resolve(normal as never, mouseToAction(normal as never, state), state)).toBe(null);
  });

  test("controller reset clears an incomplete Fact double-click pair", () => {
    const state = factsPanelState();
    let now = 1_000;
    const admission = createInteractiveInputAdmission({ now: () => now });
    const queue = createPresentedInputQueue({ flush() {}, ready: () => true });
    const presented: PresentedInteraction = {
      version: 1, frameToken: 1, interactive: true,
      storyId: state.payload.id, state: captureMouseActionState(state)
    };
    const event = factClick(state, 0);
    admission.enqueueMouse(queue, event, {
      presented, frameFailed: false, requestInputRecovery() {}, run() {}
    });
    admission.reset();
    now += 120;
    let edited = false;
    admission.enqueueMouse(queue, event, {
      presented, frameFailed: false, requestInputRecovery() {},
      run: (action) => { if (action.action === "edit") edited = true; }
    });
    expect(edited).toBeFalse();
  });
});
