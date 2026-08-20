/**
 * Placement ownership: in-flight createNode, same-story rebase, and retained
 * use-menu identity through Placement Esc.
 */
import { describe, expect, test } from "bun:test";
import { createAsideSurface } from "../src/aside-surface.js";
import {
  FROM_ASIDE_INSTRUCTION,
  placementInputLocked,
  storyPlacementMutationBlocked
} from "../src/aside-placement.js";
import { openAsideUseMenu } from "../src/aside-use.js";
import { ApiError } from "../src/api-error.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import type { StoryApi } from "../src/api.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { createStoryViewModel, rowPart } from "../src/model.js";
import {
  adoptSameStoryPayload,
  adoptStoryState
} from "../src/story-adoption.js";

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
    previewTheme: () => undefined
  };
}

async function openPlacementOnStoryAction(
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

describe("Aside Placement ownership", () => {
  test("Placement locks input during createNode and still adopts the commit", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "deferred placement prose";
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
    let resolveCreate!: (payload: typeof state.payload) => void;
    const pendingCreate = new Promise<typeof state.payload>((resolve) => {
      resolveCreate = resolve;
    });
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async (_storyId, body) => {
        createCalls += 1;
        return pendingCreate;
      }
    };
    const delayedSource = { ...source, api };
    const context = overlayContext(state, 80, 24);

    await openPlacementOnStoryAction(state, delayedSource, context);
    const stopCursor = state.placement!.cursor;
    const stop = state.placement!.stops[stopCursor]!;
    expect(stop.kind).toBe("take");

    const placing = handleOverlayAction(
      { action: "apply" },
      state,
      delayedSource,
      context
    );
    await Promise.resolve();
    expect(state.backendTask?.label).toBe("placing Side Note");
    expect(createCalls).toBe(1);

    await handleOverlayAction({ action: "cancel" }, state, delayedSource, context);
    await handleOverlayAction({ action: "focus-next" }, state, delayedSource, context);
    await handleOverlayAction({ action: "apply" }, state, delayedSource, context);
    expect(state.mode).toBe("PLACE");
    expect(state.placement!.cursor).toBe(stopCursor);
    expect(createCalls).toBe(1);

    const knownBefore = new Set(state.payload.nodes.map(({ id }) => id));
    const committed = await source.api.createNode(state.payload.id, {
      parentId: stop.kind === "take" ? stop.parentId : stop.leafId,
      text: answer,
      instruction: FROM_ASIDE_INSTRUCTION
    });
    resolveCreate(committed);
    await placing;
    await context.backend.whenIdle();

    expect(createCalls).toBe(1);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    expect(state.backendTask).toBeNull();
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed).not.toBeNull();
    expect(knownBefore.has(placed!.id)).toBeFalse();
    expect(placed!.node.text).toBe(answer);
    expect(placed!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("unrelated reconnect task does not lock Placement or show placing UI", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "reconnect while placing" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, source, context);
    const cursor = state.placement!.cursor;

    // Simulate Shift+R reconnect while still in PLACE.
    let releaseReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const reconnecting = context.backend.run("reconnecting", async () => {
      await reconnectGate;
    }, { kind: "explicit-retry" });
    await Promise.resolve();
    expect(state.backendTask?.label).toBe("reconnecting");
    expect(state.backendTask?.kind).toBe("explicit-retry");
    expect(state.placement!.placingTaskId).toBeNull();
    expect(placementInputLocked(state)).toBeFalse();

    const frame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(frame).not.toContain("placing Side Note · wait");
    expect(frame).not.toContain("placing…");
    expect(frame).toContain("Enter place");
    expect(frame).toContain("Esc back to Aside");

    // Esc/arrows remain available during unrelated backend work.
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    expect(state.placement!.cursor).not.toBe(cursor);
    await handleOverlayAction({ action: "focus-previous" }, state, source, context);
    expect(state.placement!.cursor).toBe(cursor);

    releaseReconnect();
    await reconnecting;
    await context.backend.whenIdle();
    expect(state.backendTask).toBeNull();
    expect(state.mode).toBe("PLACE");
  });

  test("createNode still locks Placement via placing task identity", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "lock by task id";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let resolveCreate!: (payload: typeof state.payload) => void;
    const pendingCreate = new Promise<typeof state.payload>((resolve) => {
      resolveCreate = resolve;
    });
    const api: StoryApi = {
      ...source.api,
      createNode: async () => pendingCreate
    };
    const delayed = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, delayed, context);

    const placing = handleOverlayAction({ action: "apply" }, state, delayed, context);
    await Promise.resolve();
    expect(state.backendTask?.label).toBe("placing Side Note");
    expect(state.placement!.placingTaskId).toBe(state.backendTask!.id);
    expect(placementInputLocked(state)).toBeTrue();

    const locked = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(locked).toContain("placing Side Note · wait");
    expect(locked).toContain("placing…");
    expect(locked).not.toContain("Enter place");

    resolveCreate(await source.api.createNode(state.payload.id, {
      parentId: state.payload.path.at(-1)!.parentId,
      text: answer,
      instruction: FROM_ASIDE_INSTRUCTION
    }));
    await placing;
    await context.backend.whenIdle();
    expect(state.mode).toBe("NAV");
  });

  test("Placement rebases a selected Take after same-story adoption", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const opening = state.payload.path[Math.max(0, state.payload.path.length - 2)]!;
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "rebased take prose" }],
      null,
      opening.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, source, context);
    const selected = state.placement!.stops[state.placement!.cursor]!;
    expect(selected.kind).toBe("take");
    expect(selected.kind === "take" && selected.partId).toBe(opening.id);

    const appended = await source.api.createNode(state.payload.id, {
      parentId: state.payload.path.at(-1)!.id,
      text: "appended while placing",
      instruction: "» continue"
    });
    adoptSameStoryPayload(state, appended, context.cache);

    expect(state.mode).toBe("PLACE");
    const rebased = state.placement!.stops[state.placement!.cursor]!;
    expect(rebased.kind).toBe("take");
    expect(rebased.kind === "take" && rebased.partId).toBe(opening.id);
    const frame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(frame).toContain(`take on ¶ ${rebased.partNumber}`);

    await handleOverlayAction({ action: "apply" }, state, source, context);
    await context.backend.whenIdle();
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed!.node.parentId).toBe(opening.parentId);
    expect(placed!.node.text).toBe("rebased take prose");
  });

  test("Placement rebases a trailing gap to the new active leaf", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "gap after append" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, source, context);
    while (state.placement!.stops[state.placement!.cursor]?.kind !== "leaf-gap") {
      await handleOverlayAction({ action: "focus-next" }, state, source, context);
    }
    const oldLeaf = state.payload.path.at(-1)!.id;

    const appended = await source.api.createNode(state.payload.id, {
      parentId: oldLeaf,
      text: "new active leaf",
      instruction: "» continue"
    });
    adoptSameStoryPayload(state, appended, context.cache);

    const stop = state.placement!.stops[state.placement!.cursor]!;
    expect(stop.kind).toBe("leaf-gap");
    const newLeaf = state.payload.path.at(-1)!.id;
    expect(newLeaf).not.toBe(oldLeaf);
    expect(stop.kind === "leaf-gap" && stop.leafId).toBe(newLeaf);
    const frame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(frame).toContain("here · new Part");
    expect(frame).toContain("gap after append");

    await handleOverlayAction({ action: "apply" }, state, source, context);
    await context.backend.whenIdle();
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed!.node.parentId).toBe(newLeaf);
    expect(placed!.node.text).toBe("gap after append");
  });

  test("when a selected Take leaves the path, Placement falls back to the leaf Take", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const mid = state.payload.path[Math.max(0, state.payload.path.length - 2)]!;
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "fallback leaf take" }],
      null,
      mid.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, source, context);
    const before = state.placement!.stops[state.placement!.cursor]!;
    expect(before.kind).toBe("take");
    if (before.kind !== "take") throw new Error("expected take stop");
    expect(before.partId).toBe(mid.id);

    // Sibling take under the same parent replaces mid on the active path.
    const switched = await source.api.createNode(state.payload.id, {
      parentId: mid.parentId,
      text: "sibling take steals the path",
      instruction: "» retake"
    });
    expect(switched.path.some(({ id }) => id === mid.id)).toBeFalse();
    adoptSameStoryPayload(state, switched, context.cache);

    expect(state.mode).toBe("PLACE");
    const stop = state.placement!.stops[state.placement!.cursor]!;
    expect(stop.kind).toBe("take");
    if (stop.kind !== "take") throw new Error("expected take stop");
    const leafId = state.payload.path.at(-1)!.id;
    expect(stop.partId).toBe(leafId);
    const frame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(frame).toContain(`take on ¶ ${stop.partNumber}`);
    expect(frame).not.toContain("here · new Part");
  });

  test("whole-story replacement clears Placement and its destination marker", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "must not survive story replace" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, source, context);
    expect(state.mode).toBe("PLACE");
    const beforeFrame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(beforeFrame).toContain("take on ¶");

    const other = (await source.api.listStories()).find((story) => story.id !== state.payload.id);
    expect(other).toBeDefined();
    const next = await source.api.loadStory(other!.id);
    adoptStoryState(state, next, context.cache);

    expect(state.placement).toBeNull();
    const modeAfter = state.mode as string;
    expect(modeAfter === "NAV" || modeAfter === "COMPOSE").toBeTrue();
    expect(state.payload.id).toBe(other!.id);
    const afterFrame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(afterFrame).not.toContain("must not survive story replace");
    expect(afterFrame).not.toContain("here · new Part");
    expect(afterFrame.includes("PLACE")).toBeFalse();
  });

  test("definite createNode failure clears guard after Placement ownership is lost", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originId = state.payload.id;
    const answer = "place after lost ownership definite fail";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let rejectCreate!: (error: Error) => void;
    const pendingCreate = new Promise<typeof state.payload>((_resolve, reject) => {
      rejectCreate = reject;
    });
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        createCalls += 1;
        if (createCalls === 1) return pendingCreate;
        return source.api.createNode(storyId, body);
      }
    };
    const delayed = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, delayed, context);

    const placing = handleOverlayAction({ action: "apply" }, state, delayed, context);
    await Promise.resolve();
    expect(createCalls).toBe(1);
    // Guard is installed before createNode; in-flight placing does not block
    // storyPlacementMutationBlocked, but the singular identity is retained.
    expect(state.unresolvedPlacement?.storyId).toBe(originId);
    expect(state.placement?.placingTaskId).not.toBeNull();

    // Lose Placement ownership mid-flight via whole-story adoption.
    const other = (await source.api.listStories()).find((story) => story.id !== originId);
    expect(other).toBeDefined();
    const next = await source.api.loadStory(other!.id);
    adoptStoryState(state, next, context.cache);
    expect(state.payload.id).toBe(other!.id);
    expect(state.placement).toBeNull();
    // Without the fix, the origin guard would still block later placement.
    expect(state.unresolvedPlacement?.storyId).toBe(originId);

    // Definite terminal outcome after ownership loss must still clear the guard.
    rejectCreate(new ApiError("provider unavailable after recovery"));
    await placing;
    await context.backend.whenIdle();
    expect(state.unresolvedPlacement).toBeNull();
    expect(storyPlacementMutationBlocked(state)).toBeFalse();
    // Ownership-gated toast must not attach to the adopted story surface.
    expect(state.toast).not.toBe("provider unavailable after recovery");
    // Later Placement on the adopted story is not permanently blocked.
    const surfaceB = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "B?", answer: "retry place after cleared guard" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surfaceB;
    state.mode = "ASIDE";
    await openPlacementOnStoryAction(state, delayed, context);
    await handleOverlayAction({ action: "apply" }, state, delayed, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(2);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("successful createNode clears guard after Placement ownership is lost", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const originId = state.payload.id;
    const answer = "place after lost ownership commit success";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let resolveCreate!: (payload: typeof state.payload) => void;
    const pendingCreate = new Promise<typeof state.payload>((resolve) => {
      resolveCreate = resolve;
    });
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async (storyId, body) => {
        createCalls += 1;
        if (createCalls === 1) return pendingCreate;
        return source.api.createNode(storyId, body);
      }
    };
    const delayed = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await openPlacementOnStoryAction(state, delayed, context);
    const stop = state.placement!.stops[state.placement!.cursor]!;
    const parentId = stop.kind === "take" ? stop.parentId : stop.leafId;

    const placing = handleOverlayAction({ action: "apply" }, state, delayed, context);
    await Promise.resolve();
    expect(createCalls).toBe(1);
    expect(state.unresolvedPlacement?.storyId).toBe(originId);
    expect(state.placement?.placingTaskId).not.toBeNull();

    // Lose Placement ownership mid-flight via whole-story adoption.
    const other = (await source.api.listStories()).find((story) => story.id !== originId);
    expect(other).toBeDefined();
    const next = await source.api.loadStory(other!.id);
    adoptStoryState(state, next, context.cache);
    expect(state.payload.id).toBe(other!.id);
    expect(state.placement).toBeNull();
    expect(state.unresolvedPlacement?.storyId).toBe(originId);

    // Committed payload for story A must clear the singular guard without
    // adopting onto B or writing place toast/focus for the adopted story.
    const committed = await source.api.createNode(originId, {
      parentId,
      text: answer,
      instruction: FROM_ASIDE_INSTRUCTION
    });
    resolveCreate(committed);
    await placing;
    await context.backend.whenIdle();
    expect(state.unresolvedPlacement).toBeNull();
    expect(storyPlacementMutationBlocked(state)).toBeFalse();
    expect(state.payload.id).toBe(other!.id);
    // Ownership-gated: no place toast on the adopted story surface.
    expect(state.toast).toBeNull();

    // Later Placement on the adopted story is admitted.
    const surfaceB = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "B?", answer: "retry place after successful orphan commit" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surfaceB;
    state.mode = "ASIDE";
    await openPlacementOnStoryAction(state, delayed, context);
    await handleOverlayAction({ action: "apply" }, state, delayed, context);
    await context.backend.whenIdle();
    expect(createCalls).toBe(2);
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.toast).toMatch(/^placed as Part \d+$/);
  });

  test("opening Placement retains surface focus, note cursor, and use-menu identity", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [
        { question: "First?", answer: "first answer" },
        { question: "Second?", answer: "second answer to place" }
      ],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    expect(openAsideUseMenu(surface, 1, 0)).toBeTrue();
    const menuBefore = surface.useMenu!;
    const sessionId = menuBefore.sessionId;

    // Move use menu to the story action, then open Placement.
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    expect(surface.useMenu).toBe(menuBefore);
    expect(menuBefore.cursor).toBe(1);
    const focusBefore = surface.focus;
    const noteCursorBefore = surface.noteCursor;

    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");
    expect(state.aside).toBeNull();
    expect(state.placement!.returnAside).toBe(surface);
    expect(state.placement!.interactionId).toBe(sessionId);
    expect(surface.focus).toBe(focusBefore);
    expect(surface.noteCursor).toBe(noteCursorBefore);
    expect(surface.useMenu).toBe(menuBefore);
    expect(surface.useMenu).toEqual({
      noteIndex: 1,
      cursor: 1,
      sessionId
    });

    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).toBe(surface);
    expect(state.placement).toBeNull();
    expect(surface.focus).toBe(focusBefore);
    expect(surface.noteCursor).toBe(noteCursorBefore);
    expect(surface.useMenu).toBe(menuBefore);
    expect(surface.useMenu).toEqual({
      noteIndex: 1,
      cursor: 1,
      sessionId
    });
  });
});
