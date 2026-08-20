/**
 * Placement keyline mouse hits: apply, destination focus, and presented
 * frame reconciliation.
 */
import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { createAsideSurface } from "../src/aside-surface.js";
import { FROM_ASIDE_INSTRUCTION } from "../src/aside-placement.js";
import { openAsideUseMenu } from "../src/aside-use.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { createStoryViewModel, rowPart } from "../src/model.js";
import {
  captureMouseActionState,
  mouseToAction
} from "../src/mouse-actions.js";
import {
  reconcilePresentedMouseAction,
  type FrozenMouseEvent,
  type PresentedInteraction
} from "../src/presented-mouse-action.js";
import { plainLine } from "../src/screens/story/frame.js";

function overlayContext(
  state: ReturnType<typeof initialState>,
  width = 80,
  height = 24
) {
  return {
    backend: new ActionRuntime(state, () => undefined),
    cache: createWrapCache<ProseStyle>(),
    repaint: () => undefined,
    renderer: { width, height } as never,
    applyTheme: () => undefined,
    previewTheme: () => undefined,
    updateChecks: INERT_UPDATE_CHECK_LIFECYCLE
  };
}

async function openPlacement(
  state: ReturnType<typeof initialState>,
  source: ReturnType<typeof demoAppSource>,
  context: ReturnType<typeof overlayContext>
): Promise<void> {
  await handleOverlayAction({ action: "cycle" }, state, source, context);
  await handleOverlayAction({ action: "open-selected" }, state, source, context);
  await handleOverlayAction({ action: "focus-next" }, state, source, context);
  await handleOverlayAction({ action: "apply" }, state, source, context);
  expect(state.mode).toBe("PLACE");
}

function findInlineHit(
  state: ReturnType<typeof initialState>,
  action: string,
  width = 80,
  height = 24
): { x: number; y: number } | null {
  const frame = renderStoryScreen(state, { width, height });
  state.hitRows = frame.derived.hitRows;
  for (let y = 0; y < frame.lines.length; y += 1) {
    const line = plainLine(frame.lines[y] ?? []);
    // Prefer the labeled glyph region when present.
    const label = action === "apply"
      ? (line.includes("Enter place") ? "Enter place" : "Enter")
      : action === "focus-next"
        ? (line.includes("Up/Down where") ? "Up/Down where" : "Up/Down")
        : action === "cancel"
          ? (line.includes("Esc back") ? "Esc back" : "Esc")
          : null;
    if (label === null || !line.includes(label)) continue;
    const x = Math.min(width - 1, Math.max(0, line.indexOf(label) + 1));
    const hit = mouseToAction({
      type: "down",
      button: 0,
      x,
      y,
      modifiers: { shift: false, alt: false, ctrl: false }
    }, state);
    if (hit?.action === action) return { x, y };
    // Scan the rest of the keyline for the inline hit.
    for (let scanX = 0; scanX < width; scanX += 1) {
      const scanned = mouseToAction({
        type: "down",
        button: 0,
        x: scanX,
        y,
        modifiers: { shift: false, alt: false, ctrl: false }
      }, state);
      if (scanned?.action === action) return { x: scanX, y };
    }
  }
  return null;
}

describe("Aside Placement keyline mouse hits", () => {
  test("Enter place hit commits Placement; Up/Down where moves destination", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "mouse place commit answer";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state);
    await openPlacement(state, source, context);
    const startCursor = state.placement!.cursor;
    const nodesBefore = state.payload.nodes.length;

    const focusHit = findInlineHit(state, "focus-next");
    expect(focusHit).not.toBeNull();
    const focusClick: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: focusHit!.x,
      y: focusHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const focusAction = mouseToAction(focusClick, state);
    expect(focusAction).toEqual({ action: "focus-next" });

    // Presented-frame reconciliation keeps the same inline action.
    const captured: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presented: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const reconciledFocus = reconcilePresentedMouseAction({
      action: focusAction!,
      event: focusClick,
      captured,
      presented,
      state
    });
    expect(reconciledFocus).toEqual({ action: "focus-next" });
    await handleOverlayAction(reconciledFocus!, state, source, context);
    expect(state.placement!.cursor).not.toBe(startCursor);

    // Move back if possible so place lands on a known stop; then click Enter place.
    await handleOverlayAction({ action: "focus-previous" }, state, source, context);
    const applyHit = findInlineHit(state, "apply");
    expect(applyHit).not.toBeNull();
    const applyClick: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: applyHit!.x,
      y: applyHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const applyAction = mouseToAction(applyClick, state);
    expect(applyAction?.action).toBe("apply");
    expect(applyAction?.rowId).toBeDefined();
    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presentedApply: PresentedInteraction = {
      version: 3,
      frameToken: 3,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const reconciledApply = reconcilePresentedMouseAction({
      action: applyAction!,
      event: applyClick,
      captured: {
        version: 2,
        frameToken: 2,
        interactive: true,
        storyId: state.payload.id,
        state: captureMouseActionState(state)
      },
      presented: presentedApply,
      state
    });
    expect(reconciledApply?.action).toBe("apply");
    expect(reconciledApply?.rowId).toBe(applyAction!.rowId);
    await handleOverlayAction(reconciledApply!, state, source, context);
    await context.backend.whenIdle();
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    expect(state.payload.nodes.length).toBe(nodesBefore + 1);
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed?.node.text).toBe(answer);
    expect(placed?.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
  });

  test("stale Enter place after leaf Take → leaf gap is dropped; same-stop click still places", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "stale place click must not commit";
    const leaf = state.payload.path.at(-1)!;
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      leaf.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    const api = {
      ...source.api,
      createNode: async (...args: Parameters<typeof source.api.createNode>) => {
        createCalls += 1;
        return source.api.createNode(...args);
      }
    };
    const tracked = { ...source, api };
    const context = overlayContext(state);
    await openPlacement(state, tracked, context);
    // Opening on the leaf Take stop; one Down reaches the trailing leaf gap.
    expect(state.placement!.stops[state.placement!.cursor]?.kind).toBe("take");
    expect(
      state.placement!.stops[state.placement!.cursor]
    ).toMatchObject({ partId: leaf.id });

    const applyHit = findInlineHit(state, "apply");
    expect(applyHit).not.toBeNull();
    const applyClick: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: applyHit!.x,
      y: applyHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const interactionId = state.placement!.interactionId;
    const takeApply = mouseToAction(applyClick, state);
    expect(takeApply).toEqual({
      action: "apply",
      rowId: `placement:${interactionId}:take:${leaf.id}`
    });
    const capturedTake: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };

    // Queued Down moves destination to the leaf gap before the click runs.
    await handleOverlayAction({ action: "focus-next" }, state, tracked, context);
    expect(state.placement!.stops[state.placement!.cursor]?.kind).toBe("leaf-gap");
    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presentedGap: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const stale = reconcilePresentedMouseAction({
      action: takeApply!,
      event: applyClick,
      captured: capturedTake,
      presented: presentedGap,
      state
    });
    expect(stale).toBeNull();
    expect(createCalls).toBe(0);
    expect(state.mode).toBe("PLACE");

    // Fresh click on the current stop still commits.
    const gapHit = findInlineHit(state, "apply");
    expect(gapHit).not.toBeNull();
    const gapClick: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: gapHit!.x,
      y: gapHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const gapApply = mouseToAction(gapClick, state);
    expect(gapApply).toEqual({
      action: "apply",
      rowId: `placement:${interactionId}:leaf-gap:${leaf.id}`
    });
    const capturedGap: PresentedInteraction = {
      version: 3,
      frameToken: 3,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presentedSame: PresentedInteraction = {
      version: 4,
      frameToken: 4,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const fresh = reconcilePresentedMouseAction({
      action: gapApply!,
      event: gapClick,
      captured: capturedGap,
      presented: presentedSame,
      state
    });
    expect(fresh?.action).toBe("apply");
    expect(fresh?.rowId).toBe(`placement:${interactionId}:leaf-gap:${leaf.id}`);
    // Relative Up/Down stays relative — no absolute rowId stamp.
    const focusHit = findInlineHit(state, "focus-next");
    expect(focusHit).not.toBeNull();
    const focusAction = mouseToAction({
      type: "down",
      button: 0,
      x: focusHit!.x,
      y: focusHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    }, state);
    expect(focusAction).toEqual({ action: "focus-next" });
    expect("rowId" in (focusAction ?? {})).toBe(false);

    await handleOverlayAction(fresh!, state, tracked, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(1);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
  });

  test("stale Enter place from Placement A is dropped after cancel + Placement B at same stop", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const leaf = state.payload.path.at(-1)!;
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [
        { question: "A?", answer: "placement A answer must not create" },
        { question: "B?", answer: "placement B answer stays open" }
      ],
      null,
      leaf.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    let lastText: string | null = null;
    const api = {
      ...source.api,
      createNode: async (
        storyId: string,
        body: Parameters<typeof source.api.createNode>[1]
      ) => {
        createCalls += 1;
        lastText = body.text;
        return source.api.createNode(storyId, body);
      }
    };
    const tracked = { ...source, api };
    const context = overlayContext(state);

    // Placement A from note 0, cursor on insert-into-story.
    expect(openAsideUseMenu(surface, 0, 1)).toBeTrue();
    await handleOverlayAction({ action: "apply" }, state, tracked, context);
    expect(state.mode).toBe("PLACE");
    expect(state.placement!.answer).toBe("placement A answer must not create");
    const interactionA = state.placement!.interactionId;
    expect(state.placement!.stops[state.placement!.cursor]).toMatchObject({
      kind: "take",
      partId: leaf.id
    });

    const applyHit = findInlineHit(state, "apply");
    expect(applyHit).not.toBeNull();
    const applyClick: FrozenMouseEvent = {
      type: "down",
      button: 0,
      x: applyHit!.x,
      y: applyHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const applyA = mouseToAction(applyClick, state);
    expect(applyA).toEqual({
      action: "apply",
      rowId: `placement:${interactionA}:take:${leaf.id}`
    });
    const capturedA: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };

    // Cancel A, open Placement B from note 1 at the same leaf Take stop.
    await handleOverlayAction({ action: "cancel" }, state, tracked, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).toBe(surface);
    // Esc restores the same menu; close it and open a new session on note B.
    await handleOverlayAction({ action: "cancel" }, state, tracked, context);
    expect(surface.useMenu).toBeNull();
    expect(openAsideUseMenu(surface, 1, 1)).toBeTrue();
    await handleOverlayAction({ action: "apply" }, state, tracked, context);
    expect(state.mode).toBe("PLACE");
    expect(state.placement!.answer).toBe("placement B answer stays open");
    const interactionB = state.placement!.interactionId;
    expect(interactionB).not.toBe(interactionA);
    expect(state.placement!.stops[state.placement!.cursor]).toMatchObject({
      kind: "take",
      partId: leaf.id
    });

    state.hitRows = renderStoryScreen(state, { width: 80, height: 24 }).derived.hitRows;
    const presentedB: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const stale = reconcilePresentedMouseAction({
      action: applyA!,
      event: applyClick,
      captured: capturedA,
      presented: presentedB,
      state
    });
    expect(stale).toBeNull();
    expect(createCalls).toBe(0);
    expect(lastText).toBeNull();
    expect(state.mode).toBe("PLACE");
    expect(state.placement!.answer).toBe("placement B answer stays open");
    expect(state.placement!.interactionId).toBe(interactionB);
  });

  test("PLACE does not admit unrelated modal inline actions", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "mouse place" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state);
    await openPlacement(state, source, context);
    // Fabricate a non-PLACE inline hit; PLACE must ignore it.
    state.hitRows = [{
      target: { kind: "inline-action", action: "open-request" },
      left: 0,
      right: 80
    }];
    const action = mouseToAction({
      type: "down",
      button: 0,
      x: 10,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false }
    }, state);
    expect(action).toBeNull();
  });
});
