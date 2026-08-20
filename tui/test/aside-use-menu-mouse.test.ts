/**
 * Aside use-menu mouse hits and presented-frame reconciliation.
 */
import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { renderStoryScreen } from "../src/screens/story.js";
import {
  captureMouseActionState,
  mouseToAction
} from "../src/mouse-actions.js";
import {
  reconcilePresentedMouseAction,
  type FrozenMouseEvent,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";

function overlayContext(
  state: ReturnType<typeof initialState>,
  width?: number,
  height?: number
) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: width === undefined || height === undefined
      ? null
      : { width, height } as never,
    applyTheme: () => undefined,
    previewTheme: () => undefined,
    updateChecks: INERT_UPDATE_CHECK_LIFECYCLE
  };
}

describe("Aside use-menu mouse", () => {
  test("use-menu mouse click selects insert into story then opens Placement", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "from mouse menu" }]
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu?.cursor).toBe(0);

    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    state.hitRows = frame.derived.hitRows;
    let storyY = -1;
    const storyX = 40;
    for (let y = 0; y < frame.derived.hitRows.length; y += 1) {
      const action = mouseToAction({
        type: "down",
        button: 0,
        x: storyX,
        y,
        modifiers: { shift: false, alt: false, ctrl: false }
      }, state);
      if (action?.action === "focus-index"
        && action.rowId !== undefined
        && action.rowId.endsWith(":insert-into-story")) {
        storyY = y;
        break;
      }
    }
    expect(storyY).toBeGreaterThan(-1);
    const click: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: storyX,
      y: storyY,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const sessionId = surface.useMenu!.sessionId;
    const storyRowId = `aside-use:${sessionId}:insert-into-story`;

    // Captured at cursor 0; presented after a paint-only cursor change so
    // reconciliation must re-resolve by stable session+action id, not index.
    const capturedFocus: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    expect(capturedFocus.state.aside?.useMenu?.cursor).toBe(0);
    const first = mouseToAction(click, state);
    expect(first).toEqual({
      action: "focus-index",
      index: 1,
      rowId: storyRowId
    });
    // Present a different frame identity with the same hits/story, as if a
    // repaint reordered nothing but is a new presented snapshot.
    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presentedFocus: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    expect(presentedFocus).not.toBe(capturedFocus);
    const reconciledFocus = reconcilePresentedMouseAction({
      action: first!,
      event: click,
      captured: capturedFocus,
      presented: presentedFocus,
      state
    });
    expect(reconciledFocus).toEqual({
      action: "focus-index",
      index: 1,
      rowId: storyRowId
    });
    await handleOverlayAction(reconciledFocus!, state, source, context);
    expect(surface.useMenu?.cursor).toBe(1);

    // Second click: captured before selection; presented after selection so
    // open-selected survives via selected session+action identity.
    const afterFocusFrame = renderStoryScreen(state, { width: 80, height: 24 });
    state.hitRows = afterFocusFrame.derived.hitRows;
    const capturedOpen: PresentedInteraction = {
      version: 3,
      frameToken: 3,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    expect(capturedOpen.state.aside?.useMenu?.cursor).toBe(1);
    const second = mouseToAction(click, state);
    expect(second?.action).toBe("open-selected");
    expect(second?.rowId).toBe(storyRowId);
    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presentedOpen: PresentedInteraction = {
      version: 4,
      frameToken: 4,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    expect(presentedOpen).not.toBe(capturedOpen);
    const reconciledOpen = reconcilePresentedMouseAction({
      action: second!,
      event: click,
      captured: capturedOpen,
      presented: presentedOpen,
      state
    });
    expect(reconciledOpen?.action).toBe("open-selected");
    await handleOverlayAction(reconciledOpen!, state, source, context);
    expect(state.mode).toBe("PLACE");
    expect(state.aside).toBeNull();
    expect(state.placement?.answer).toBe("from mouse menu");
    expect(state.placement?.interactionId).toBe(sessionId);
  });

  test("stale use-menu click for note A is dropped after menu reopens on note B", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [
        { question: "A?", answer: "answer A must not run" },
        { question: "B?", answer: "answer B stays selected" }
      ]
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    // Open menu on note A (index 0).
    surface.noteCursor = 0;
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu?.noteIndex).toBe(0);
    const sessionA = surface.useMenu!.sessionId;

    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    state.hitRows = frame.derived.hitRows;
    let storyY = -1;
    const storyX = 40;
    for (let y = 0; y < frame.derived.hitRows.length; y += 1) {
      const action = mouseToAction({
        type: "down",
        button: 0,
        x: storyX,
        y,
        modifiers: { shift: false, alt: false, ctrl: false }
      }, state);
      if (action?.action === "focus-index"
        && action.rowId === `aside-use:${sessionA}:insert-into-story`) {
        storyY = y;
        break;
      }
    }
    expect(storyY).toBeGreaterThan(-1);
    const click: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: storyX,
      y: storyY,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const capturedA: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const actionA = mouseToAction(click, state);
    expect(actionA).toEqual({
      action: "focus-index",
      index: 1,
      rowId: `aside-use:${sessionA}:insert-into-story`
    });

    // Keyboard closes A and opens the same action on note B.
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(surface.useMenu).toBeNull();
    surface.noteCursor = 1;
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    expect(surface.useMenu?.noteIndex).toBe(1);
    expect(surface.useMenu?.cursor).toBe(1);
    expect(surface.useMenu!.sessionId).not.toBe(sessionA);

    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presentedB: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const stale = reconcilePresentedMouseAction({
      action: actionA!,
      event: click,
      captured: capturedA,
      presented: presentedB,
      state
    });
    expect(stale).toBeNull();
    expect(surface.useMenu?.noteIndex).toBe(1);
    expect(surface.useMenu?.cursor).toBe(1);
    expect(state.mode).toBe("ASIDE");
  });
});
