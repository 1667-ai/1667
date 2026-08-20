/**
 * Placement/Aside render and key edge cases: narrow use-menu footer, offline
 * retry ownership, and leaf-gap markers around chapter chrome.
 */
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createAsideSurface } from "../src/aside-surface.js";
import {
  FROM_ASIDE_INSTRUCTION,
  PLACEMENT_PLACING_KEYLINE,
  PLACEMENT_PLACING_STATUS,
  PLACEMENT_STATUS_TEXT,
  PLACEMENT_UNCERTAIN_STATUS
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
import { adoptSameStoryPayload } from "../src/story-adoption.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { resolveKey } from "../src/keys.js";
import { plainLine } from "../src/screens/story/frame.js";

function key(
  name: string,
  options: { shift?: boolean; ctrl?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: name.length === 1 ? name : name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: false,
    option: false,
    super: false
  } as KeyEvent;
}

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
    previewTheme: () => undefined
  };
}

function frameText(
  state: ReturnType<typeof initialState>,
  width: number,
  height = 24
): string {
  return renderStoryScreen(state, { width, height }).lines.map(plainLine).join("\n");
}

describe("Aside placement render and offline keys", () => {
  test("use-menu footer keeps ↵ and esc complete at 20 and 21 columns", () => {
    for (const width of [20, 21] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      state.mode = "ASIDE";
      state.aside = createAsideSurface(state.payload.id, "Lantern", [{
        question: "Q?",
        answer: "a few answer words"
      }]);
      expect(openAsideUseMenu(state.aside, 0, 0)).toBeTrue();
      const text = frameText(state, width);
      expect(text).toContain("↵");
      expect(text).toContain("esc");
      // Action names may truncate; the declared footer tokens must not.
      expect(text).toContain("insert");
    }
  });

  test("Shift+R retries offline in use-menu and PLACE; composer still types R", () => {
    const offline = { connectionDown: true as const };
    expect(resolveKey(key("r", { shift: true }), "ASIDE", {
      ...offline,
      asideLayer: "use-menu"
    }).action).toBe("retry");
    expect(resolveKey(key("r", { shift: true }), "PLACE", offline).action).toBe("retry");
    // Active Aside composer is a text owner: capital R is input, not retry.
    expect(resolveKey(key("r", { shift: true }), "ASIDE", {
      ...offline,
      asideLayer: "composer"
    }).action).not.toBe("retry");
    expect(resolveKey(key("R"), "ASIDE", {
      ...offline,
      asideLayer: "composer"
    }).action).not.toBe("retry");
  });

  test("offline PLACE Enter makes no createNode and creates no guard", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "offline place answer" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    let createCalls = 0;
    const api: StoryApi = {
      ...source.api,
      createNode: async () => {
        createCalls += 1;
        throw new Error("should not run offline");
      }
    };
    const offlineSource = { ...source, api };
    const context = overlayContext(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, offlineSource, context);
    await handleOverlayAction({ action: "open-selected" }, state, offlineSource, context);
    await handleOverlayAction({ action: "focus-next" }, state, offlineSource, context);
    await handleOverlayAction({ action: "apply" }, state, offlineSource, context);
    expect(state.mode).toBe("PLACE");

    state.connection = {
      down: true,
      attempt: 1,
      nextRetryAt: state.now + 5_000,
      error: null
    };
    const cursor = state.placement!.cursor;
    await handleOverlayAction({ action: "apply" }, state, offlineSource, context);
    await context.backend.whenIdle();

    expect(createCalls).toBe(0);
    expect(state.mode).toBe("PLACE");
    expect(state.placement).not.toBeNull();
    expect(state.placement!.cursor).toBe(cursor);
    expect(state.placement!.placingTaskId).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.toast).toBe("offline · reading still works");
    // Shift+R still routes as retry while PLACE is offline.
    expect(resolveKey(key("r", { shift: true }), "PLACE", {
      connectionDown: true
    }).action).toBe("retry");
  });

  test("offline banner retry hit stays above the use-menu scrim", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "ASIDE";
    state.connection = {
      down: true,
      attempt: 1,
      nextRetryAt: state.now + 5_000,
      error: null
    };
    state.aside = createAsideSurface(state.payload.id, state.payload.title, [{
      question: "Q?",
      answer: "offline answer"
    }]);
    expect(openAsideUseMenu(state.aside, 0, 0)).toBeTrue();
    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    state.hitRows = frame.derived.hitRows;
    const banner = plainLine(frame.lines[0] ?? []);
    expect(banner).toContain("connection lost");
    // Prefer the labeled retry affordance when present.
    const retryLabel = banner.includes("R retries now") ? "R retries now" : "retry now";
    expect(banner).toContain(retryLabel);
    const retryX = Math.min(79, Math.max(0, banner.indexOf(retryLabel) + 1));
    const action = mouseToAction({
      type: "down",
      button: 0,
      x: retryX,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false }
    }, state);
    expect(action).toEqual({ action: "retry" });
    expect(action?.action).not.toBe("cancel");
  });

  test("locked Placement shows placing status and hides key hints", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "locked place prose" }],
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

    await handleOverlayAction({ action: "cycle" }, state, delayed, context);
    await handleOverlayAction({ action: "open-selected" }, state, delayed, context);
    await handleOverlayAction({ action: "focus-next" }, state, delayed, context);
    await handleOverlayAction({ action: "apply" }, state, delayed, context);
    expect(state.mode).toBe("PLACE");

    const placing = handleOverlayAction({ action: "apply" }, state, delayed, context);
    await Promise.resolve();
    expect(state.backendTask?.label).toBe("placing Side Note");

    const locked = frameText(state, 80);
    expect(locked).toContain(PLACEMENT_PLACING_STATUS);
    expect(locked).toContain(PLACEMENT_PLACING_KEYLINE);
    expect(locked).not.toContain(PLACEMENT_STATUS_TEXT);
    expect(locked).not.toContain("Up/Down where");
    expect(locked).not.toContain("Enter place");
    expect(locked).not.toContain("Esc back to Aside");

    resolveCreate(await source.api.createNode(state.payload.id, {
      parentId: state.payload.path.at(-1)!.parentId,
      text: "locked place prose",
      instruction: FROM_ASIDE_INSTRUCTION
    }));
    await placing;
    await context.backend.whenIdle();
    expect(state.mode).toBe("NAV");
  });

  test("failed place restores Placement status and keyline", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer: "restore keyline prose" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const api: StoryApi = {
      ...source.api,
      createNode: async () => {
        // Definite application outcome: pending clears and input restores.
        throw new ApiError("provider unavailable");
      }
    };
    const failing = { ...source, api };
    const context = overlayContext(state, 80, 24);

    await handleOverlayAction({ action: "cycle" }, state, failing, context);
    await handleOverlayAction({ action: "open-selected" }, state, failing, context);
    await handleOverlayAction({ action: "focus-next" }, state, failing, context);
    await handleOverlayAction({ action: "apply" }, state, failing, context);
    expect(state.mode).toBe("PLACE");

    await handleOverlayAction({ action: "apply" }, state, failing, context);
    await context.backend.whenIdle();
    expect(state.mode).toBe("PLACE");
    expect(state.backendTask).toBeNull();
    expect(state.placement!.placingTaskId).toBeNull();
    expect(state.unresolvedPlacement).toBeNull();
    expect(state.toast).toBe("provider unavailable");

    // Status restores immediately; toast briefly owns the keyline slot.
    const withToast = frameText(state, 80);
    expect(withToast).toContain(PLACEMENT_STATUS_TEXT);
    expect(withToast).not.toContain(PLACEMENT_PLACING_STATUS);
    expect(withToast).not.toContain(PLACEMENT_PLACING_KEYLINE);

    state.toast = null;
    const restored = frameText(state, 80);
    expect(restored).toContain(PLACEMENT_STATUS_TEXT);
    expect(restored).toContain("Up/Down where");
    expect(restored).toContain("Enter place");
    expect(restored).toContain("Esc back to Aside");
    expect(restored).not.toContain(PLACEMENT_PLACING_STATUS);
    expect(restored).not.toContain(PLACEMENT_PLACING_KEYLINE);
  });

  test("leaf-gap marker trails chapter divider after the active leaf", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const leaf = state.payload.path.at(-1)!;
    const created = await source.api.createChapterBreak(
      state.payload.id,
      leaf.id,
      "After leaf"
    );
    adoptSameStoryPayload(state, created.payload, createWrapCache<ProseStyle>());
    const viewBefore = createStoryViewModel(state.payload);
    const leafIndex = viewBefore.rows.findIndex(
      (row) => row.kind === "part" && row.id === leaf.id
    );
    expect(leafIndex).toBeGreaterThan(-1);
    const trailing = viewBefore.rows.slice(leafIndex + 1);
    expect(trailing.some((row) => row.kind === "chapter-divider")).toBeTrue();

    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Where?", answer: "part after the boundary" }],
      null,
      leaf.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");
    while (state.placement!.stops[state.placement!.cursor]?.kind !== "leaf-gap") {
      await handleOverlayAction({ action: "focus-next" }, state, source, context);
    }

    const lines = renderStoryScreen(state, { width: 80, height: 36 }).lines.map(plainLine);
    const leafLine = lines.findIndex((line) => line.includes(leaf.text.slice(0, 12)));
    const dividerLine = lines.findIndex((line) =>
      line.toLowerCase().includes("chapter") || line.includes("After leaf")
    );
    const markerLine = lines.findIndex((line) => line.includes("here · new Part"));
    expect(markerLine).toBeGreaterThan(-1);
    expect(leafLine).toBeGreaterThan(-1);
    // Marker is below the leaf and, when the divider paints, below the divider.
    expect(markerLine).toBeGreaterThan(leafLine);
    if (dividerLine >= 0) expect(markerLine).toBeGreaterThan(dividerLine);
    expect(lines[markerLine]).toContain("part after the boundary");

    const pathBefore = state.payload.path.length;
    await handleOverlayAction({ action: "apply" }, state, source, context);
    await context.backend.whenIdle();
    expect(state.mode).toBe("NAV");
    expect(state.payload.path.length).toBe(pathBefore + 1);
    const placed = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(placed).not.toBeNull();
    expect(placed!.node.parentId).toBe(leaf.id);
    expect(placed!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(placed!.node.text).toBe("part after the boundary");
    // New Part is the first path node after the leaf that closed the chapter.
    const path = state.payload.path;
    const leafPathIndex = path.findIndex(({ id }) => id === leaf.id);
    expect(path[leafPathIndex + 1]?.id).toBe(placed!.id);
  });

  test("PLACE status keeps Enter assurance at 80 and narrow with a long leaf-gap answer", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    // Eight-plus words: leaf-gap label previews eight words then ellipsis.
    const answer = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Where?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");
    while (state.placement!.stops[state.placement!.cursor]?.kind !== "leaf-gap") {
      await handleOverlayAction({ action: "focus-next" }, state, source, context);
    }

    for (const width of [80, 48] as const) {
      const text = frameText(state, width);
      expect(text).toContain(PLACEMENT_STATUS_TEXT);
      // Destination label may clip; the required assurance must not.
      expect(text).toContain("nothing is written until Enter");
    }
  });

  test("PLACE status uses chrome for normal and placing; warning only when uncertain", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const answer = "status role prose for placement browsing";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Q?", answer }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");

    const statusRoles = (width = 80) => {
      const frame = renderStoryScreen(state, { width, height: 24 });
      const line = frame.lines.find((parts) =>
        plainLine(parts).includes("PLACE")
      );
      expect(line).toBeDefined();
      return line!.filter((part) => part.text.trim().length > 0).map((part) => part.role);
    };

    // Normal browsing: no danger text on the status line body.
    const browsing = statusRoles();
    expect(browsing).toContain("chrome");
    expect(browsing.includes("danger text")).toBeFalse();

    // In-flight place keeps normal chrome, not prune danger.
    state.placement!.placingTaskId = 42;
    state.backendTask = {
      id: 42,
      kind: "action",
      label: "placing Side Note",
      storyId: state.payload.id
    };
    const placing = statusRoles();
    expect(plainLine(
      renderStoryScreen(state, { width: 80, height: 24 }).lines.find((parts) =>
        plainLine(parts).includes("PLACE")
      )!
    )).toContain(PLACEMENT_PLACING_STATUS);
    expect(placing).toContain("chrome");
    expect(placing.includes("danger text")).toBeFalse();

    // Uncertain outcome may warn; still not prune danger.
    state.placement!.placingTaskId = null;
    state.backendTask = null;
    state.unresolvedPlacement = {
      storyId: state.payload.id,
      submission: {
        knownNodeIds: new Set(state.payload.nodes.map((node) => node.id)),
        parentId: state.payload.path.at(-1)!.id,
        text: answer,
        instruction: FROM_ASIDE_INSTRUCTION,
        partNumber: state.payload.path.length + 1
      }
    };
    const uncertainLine = renderStoryScreen(state, { width: 80, height: 24 }).lines.find(
      (parts) => plainLine(parts).includes("PLACE")
    )!;
    expect(plainLine(uncertainLine)).toContain(PLACEMENT_UNCERTAIN_STATUS);
    const uncertainRoles = uncertainLine
      .filter((part) => part.text.trim().length > 0)
      .map((part) => part.role);
    expect(uncertainRoles).toContain("context warning");
    expect(uncertainRoles.includes("danger text")).toBeFalse();
  });
});
