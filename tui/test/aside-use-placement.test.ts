/**
 * Stage 1/2 Side Note focus, use menu, and Placement behavior.
 */
import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createAsideSurface } from "../src/aside-surface.js";
import {
  openAside,
  sendAsideQuestion
} from "../src/aside-actions.js";
import {
  buildPlacementStops,
  initialPlacementCursor,
  FROM_ASIDE_INSTRUCTION,
  PLACEMENT_STATUS_TEXT
} from "../src/aside-placement.js";
import { noteCursorAfterHistoryScroll } from "../src/aside-note-scroll.js";
import { pasteInto, resolveKey } from "../src/keys.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import type { StoryApi } from "../src/api.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { openDirectComposer } from "../src/composer-ownership.js";
import { moveComposerTo, setComposerText } from "../src/composer-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { createStoryViewModel, rowIndexForNode, rowPart } from "../src/model.js";

function key(
  name: string,
  options: { shift?: boolean; ctrl?: boolean; super?: boolean } = {}
): KeyEvent {
  return {
    name,
    sequence: name,
    shift: options.shift ?? false,
    ctrl: options.ctrl ?? false,
    meta: false,
    option: false,
    super: options.super ?? false
  } as KeyEvent;
}

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

describe("Aside use menu and Placement", () => {
  test("focus, use-menu, and PLACE key layers", () => {
    expect(resolveKey(key("tab"), "ASIDE", { asideLayer: "composer" }).action).toBe("cycle");
    expect(resolveKey(key("return"), "ASIDE", { asideLayer: "notes" }).action)
      .toBe("open-selected");
    expect(resolveKey(key("up"), "ASIDE", { asideLayer: "notes" }).action)
      .toBe("focus-previous");
    expect(resolveKey(key("return"), "ASIDE", { asideLayer: "use-menu" }).action)
      .toBe("apply");
    expect(resolveKey(key("up"), "ASIDE", { asideLayer: "use-menu" }).action)
      .toBe("focus-previous");
    expect(resolveKey(key("down"), "PLACE").action).toBe("focus-next");
    expect(resolveKey(key("return"), "PLACE").action).toBe("apply");
    expect(resolveKey(key("escape"), "PLACE").action).toBe("cancel");
  });

  test("Side Note use menu inserts complete answer into Direct compose", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(openDirectComposer(state)).toBeTrue();
    setComposerText(state.composer, "draft replace right");
    const selectionStart = "draft ".length;
    moveComposerTo(state.composer, "draft replace".length);
    state.composer.anchor = selectionStart;
    const answer = "complete Side Note answer";
    const surface = createAsideSurface(state.payload.id, state.payload.title, [
      { question: "first?", answer: "older answer" },
      { question: "Why the lantern?", answer }
    ]);
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    expect(surface.noteCursor).toBe(1);
    const notesFrame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(notesFrame).toContain("▸ Q: Why the lantern?");
    expect(notesFrame).toContain("Tab ask");
    expect(notesFrame).toContain("Enter use");
    expect(pasteInto(state, "hidden paste")).toBeFalse();
    expect(surface.composer.text).toBe("");
    expect(state.composer.text).toBe("draft replace right");

    await handleOverlayAction({ action: "focus-previous" }, state, source, context);
    expect(surface.noteCursor).toBe(0);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    expect(surface.noteCursor).toBe(1);

    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu).toMatchObject({ noteIndex: 1, cursor: 0 });
    expect(typeof surface.useMenu?.sessionId).toBe("string");
    const menuFrame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(menuFrame).toContain("use answer ·");
    expect(menuFrame).toContain("insert into compose");
    expect(menuFrame).toContain("insert into story…");
    expect(menuFrame).toContain("insert at the composer cur");
    expect(menuFrame).toContain("select a position");
    expect(menuFrame).not.toContain("new fact");
    expect(menuFrame).not.toContain("delete note");
    expect(menuFrame).not.toContain("author's note");

    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(surface.useMenu).toBeNull();
    expect(surface.focus).toBe("notes");
    expect(surface.noteCursor).toBe(1);

    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    await handleOverlayAction({ action: "apply" }, state, source, context);

    expect(state.mode).toBe("COMPOSE");
    expect(state.aside).toBeNull();
    expect(state.composer.text).toBe(`draft ${answer} right`);
    expect(state.composer.cursor).toBe(selectionStart + answer.length);
    expect(state.composer.anchor).toBeNull();

    // Esc ladder: use menu → notes → composer → leave Aside.
    state.aside = createAsideSurface(state.payload.id, state.payload.title, [
      { question: "Q?", answer: "A." }
    ]);
    state.mode = "ASIDE";
    const again = state.aside;
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(again.useMenu).not.toBeNull();
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(again.focus).toBe("notes");
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(again.focus).toBe("composer");
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(state.mode).toBe("NAV");
    expect(state.aside).toBeNull();
  });

  test("Tab stays on the composer while Ask is busy; Esc still stops", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({
        notes: [{ question: "saved?", answer: "yes" }]
      }),
      askAside: async (_id, _q, _onDelta, signal) => {
        await gate;
        if (signal.aborted) return null;
        return { notes: [{ question: "saved?", answer: "yes" }] };
      },
      clearAside: async () => state.payload
    };
    await openAside(state, api, { entryPointsOpen: true });
    const context = overlayContext(state, 80, 24);
    const pending = sendAsideQuestion(state, api, "In flight?");
    await Promise.resolve();
    expect(state.aside!.busy).toBeTrue();
    expect(state.aside!.focus).toBe("composer");

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(state.aside!.focus).toBe("composer");
    expect(state.aside!.useMenu).toBeNull();

    await handleOverlayAction({ action: "cancel" }, state, source, context);
    release();
    await pending;
    expect(state.mode).toBe("ASIDE");
    expect(state.aside!.busy).toBeFalse();
    expect(state.aside!.composer.text).toBe("In flight?");
    expect(state.aside!.notes).toHaveLength(1);
  });

  test("leaving the composer for Side Notes disarms Clear confirmation", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(state.payload.id, state.payload.title, [
      { question: "Q?", answer: "A." }
    ]);
    state.aside = surface;
    state.mode = "ASIDE";
    surface.confirmClear = true;
    const context = overlayContext(state, 80, 24);

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    expect(surface.confirmClear).toBeFalse();
  });

  test("Up/Down keeps the focused Side Note inside the history viewport", async () => {
    const notes = Array.from({ length: 12 }, (_, index) => ({
      question: `note-q-${index}`,
      answer: index === 6 ? "tall answer\n".repeat(20) : `note-a-${index}`
    }));
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(state.payload.id, state.payload.title, notes);
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 40;
    const height = 12;
    const context = overlayContext(state, width, height);
    const frameText = () => renderStoryScreen(state, { width, height })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    // Newest note after open; scroll to the oldest through Up.
    for (let step = 0; step < notes.length; step += 1) {
      await handleOverlayAction({ action: "focus-previous" }, state, source, context);
    }
    expect(surface.noteCursor).toBe(0);
    let frame = frameText();
    expect(frame).toContain("note-q-0");
    expect(frame).toContain("▸ Q:");

    for (let step = 0; step < notes.length - 1; step += 1) {
      await handleOverlayAction({ action: "focus-next" }, state, source, context);
      frame = frameText();
      expect(frame).toContain(`note-q-${surface.noteCursor}`);
      expect(frame).toContain("▸ Q:");
    }
    expect(surface.noteCursor).toBe(notes.length - 1);
    expect(frame).toContain(`note-q-${notes.length - 1}`);
  });

  test("PageUp/PageDown and line scroll keep notes-focused selection visible", async () => {
    const notes = Array.from({ length: 14 }, (_, index) => ({
      question: `scroll-q-${index}`,
      answer: `scroll-a-${index} with a few extra words for wrap`
    }));
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(state.payload.id, state.payload.title, notes);
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 40;
    const height = 12;
    const context = overlayContext(state, width, height);
    const frameText = () => renderStoryScreen(state, { width, height })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    expect(surface.noteCursor).toBe(notes.length - 1);

    // Page toward older history while notes own focus.
    for (let page = 0; page < 6; page += 1) {
      await handleOverlayAction({ action: "scroll-up" }, state, source, context);
      const frame = frameText();
      expect(frame).toContain(`scroll-q-${surface.noteCursor}`);
      expect(frame).toContain("▸ Q:");
    }
    expect(surface.noteCursor).toBeLessThan(notes.length - 1);
    const afterPageUp = surface.noteCursor;

    // Line/wheel scroll further toward older notes.
    for (let step = 0; step < 8; step += 1) {
      await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    }
    const afterLineUp = surface.noteCursor;
    expect(afterLineUp <= afterPageUp).toBeTrue();
    let frame = frameText();
    expect(frame).toContain(`scroll-q-${surface.noteCursor}`);
    expect(frame).toContain("▸ Q:");

    // Enter opens the use menu for the visible focused note.
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu).not.toBeNull();
    expect(surface.useMenu!.noteIndex).toBe(surface.noteCursor);
    expect(surface.notes[surface.useMenu!.noteIndex]!.question)
      .toBe(`scroll-q-${surface.noteCursor}`);
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(surface.useMenu).toBeNull();

    // Page/line down toward newer notes keeps selection visible.
    for (let page = 0; page < 6; page += 1) {
      await handleOverlayAction({ action: "scroll-down" }, state, source, context);
      frame = frameText();
      expect(frame).toContain(`scroll-q-${surface.noteCursor}`);
      expect(frame).toContain("▸ Q:");
    }
    for (let step = 0; step < 8; step += 1) {
      await handleOverlayAction({ action: "scroll-line-down" }, state, source, context);
    }
    frame = frameText();
    expect(frame).toContain(`scroll-q-${surface.noteCursor}`);
    expect(frame).toContain("▸ Q:");
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu!.noteIndex).toBe(surface.noteCursor);

    // Composer focus: history scroll must not steal noteCursor for Enter later.
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("composer");
    const cursorWhileComposer = surface.noteCursor;
    await handleOverlayAction({ action: "scroll-up" }, state, source, context);
    await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    expect(surface.focus).toBe("composer");
    expect(surface.noteCursor).toBe(cursorWhileComposer);
  });

  test("separator-only rows do not keep an invisible note focused", async () => {
    // note0 content [0,4), separator at 4; note1 content [5,8)
    const noteStarts = [0, 5];
    const noteContentEnds = [4, 8];
    const bodyLength = 9;
    // Viewport shows only row 4 — the separator blank of note 0.
    const cursor = noteCursorAfterHistoryScroll(
      2,
      noteStarts,
      noteContentEnds,
      bodyLength,
      4,
      1,
      0,
      1
    );
    expect(cursor).not.toBe(0);

    // Integration: after line scroll, Enter menu matches the visible ▸ note.
    const notes = [
      { question: "old-q", answer: "line-a\nline-b\nline-c\nline-d\nline-e\nline-f" },
      { question: "new-q", answer: "visible newer answer" }
    ];
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(state.payload.id, state.payload.title, notes);
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 40;
    const height = 10;
    const context = overlayContext(state, width, height);
    const frameText = () => renderStoryScreen(state, { width, height })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    for (let step = 0; step < 40; step += 1) {
      await handleOverlayAction({ action: "scroll-line-up" }, state, source, context);
    }
    const frame = frameText();
    expect(frame).toContain("▸ Q:");
    const focusedQuestion = notes[surface.noteCursor]!.question;
    expect(frame).toContain(focusedQuestion);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu!.noteIndex).toBe(surface.noteCursor);
    expect(surface.notes[surface.useMenu!.noteIndex]!.question).toBe(focusedQuestion);
  });

  test("Enter re-anchors a note hidden by stale scrollTop after reflow before use menu", async () => {
    const notes = Array.from({ length: 16 }, (_, index) => ({
      question: `anchor-q-${index}`,
      answer: `anchor-a-${index} ${"word ".repeat(12)}`
    }));
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(state.payload.id, state.payload.title, notes);
    state.aside = surface;
    state.mode = "ASIDE";
    // Wide layout first: focus an older note and establish a real scroll offset.
    const wide = overlayContext(state, 80, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, wide);
    expect(surface.focus).toBe("notes");
    for (let step = 0; step < notes.length; step += 1) {
      await handleOverlayAction({ action: "focus-previous" }, state, source, wide);
    }
    expect(surface.noteCursor).toBe(0);
    expect(surface.scrollTop === null || surface.scrollTop === 0).toBeTrue();

    // Stale offset as if the terminal reflowed under a narrower width.
    surface.scrollTop = 40;
    // Header-height reflow: a longer title changes chrome rows vs bodyRows.
    surface.storyTitle = "Reflow title that wraps ".repeat(3);
    const narrowW = 40;
    const narrowH = 16;
    const hidden = renderStoryScreen(state, { width: narrowW, height: narrowH })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(hidden).not.toContain("anchor-q-0");

    // Enter uses noteCursor 0; re-anchor must run before the menu owns the surface.
    const narrow = overlayContext(state, narrowW, narrowH);
    await handleOverlayAction({ action: "open-selected" }, state, source, narrow);
    expect(surface.useMenu).not.toBeNull();
    expect(surface.useMenu!.noteIndex).toBe(0);
    expect(surface.noteCursor).toBe(0);
    expect(surface.notes[surface.useMenu!.noteIndex]!.question).toBe("anchor-q-0");
    // Re-anchor ran under the new viewport: note start is on-screen again.
    expect(surface.scrollTop === null || surface.scrollTop === 0).toBeTrue();

    // Menu closes with Esc; history stays on the re-anchored note under new size.
    await handleOverlayAction({ action: "cancel" }, state, source, narrow);
    expect(surface.useMenu).toBeNull();
    expect(surface.focus).toBe("notes");
    const shown = renderStoryScreen(state, { width: narrowW, height: narrowH })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(shown).toContain("anchor-q-0");
    expect(shown).toContain("▸");
  });

  test("Placement: initial stop, Take place, leaf gap, cancel restore, busy reject", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const pathLen = state.payload.path.length;
    expect(pathLen).toBeGreaterThan(1);
    // Focus a mid-line Part so the opening stop is not the leaf.
    const openingPathIndex = Math.max(0, pathLen - 2);
    const openingPart = state.payload.path[openingPathIndex]!;
    state.focusIndex = rowIndexForNode(
      createStoryViewModel(state.payload),
      openingPart.id
    );
    const answer = "prose placed from a Side Note";
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Where?", answer }],
      null,
      openingPart.id
    );
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);

    const stops = buildPlacementStops(state.payload);
    expect(stops.some((stop) => stop.kind === "take")).toBeTrue();
    expect(stops.at(-1)?.kind).toBe("leaf-gap");
    expect(stops.filter((stop) => stop.kind === "leaf-gap")).toHaveLength(1);
    expect(initialPlacementCursor(stops, openingPart.id)).toBe(
      stops.findIndex((stop) => stop.kind === "take" && stop.partId === openingPart.id)
    );
    expect(initialPlacementCursor(stops, "missing-part-id")).toBe(
      stops.findLastIndex((stop) => stop.kind === "take")
    );

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu?.cursor).toBe(0);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    expect(surface.useMenu?.cursor).toBe(1);

    // Busy generation refuses Placement without leaving Aside.
    state.stream = {
      nodeId: "virtual",
      parentId: null,
      instruction: "",
      text: "…",
      startedAt: new Date().toISOString(),
      retakeNodeId: undefined
    } as never;
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.placement).toBeNull();
    expect(state.toast).toContain("stream running");
    state.stream = null;
    state.toast = null;

    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");
    expect(state.aside).toBeNull();
    expect(state.placement).not.toBeNull();
    expect(state.placement!.cursor).toBe(
      stops.findIndex((stop) => stop.kind === "take" && stop.partId === openingPart.id)
    );
    expect(state.placement!.returnAside).toBe(surface);
    const frameText = () => renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    const placeFrame = frameText();
    expect(placeFrame).toContain("PLACE");
    expect(placeFrame).toContain(PLACEMENT_STATUS_TEXT);
    expect(placeFrame).toContain("Up/Down where");
    expect(placeFrame).toContain("Enter place");
    expect(placeFrame).toContain("Esc back to Aside");
    // Destination marker is painted on the story surface at the Take stop.
    const openingPartView = rowPart(
      createStoryViewModel(state.payload),
      rowIndexForNode(createStoryViewModel(state.payload), openingPart.id)
    )!;
    const takeLabel = `take on ¶ ${openingPartView.number}`;
    const takePosition = `take ${openingPartView.siblingCount + 1}/${openingPartView.siblingCount + 1}`;
    expect(placeFrame).toContain(takeLabel);
    expect(placeFrame).toContain(takePosition);
    expect(placeFrame).not.toContain("here · new Part");

    // Up/Down moves the marker; the previous destination is gone.
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    const movedFrame = frameText();
    const movedStop = state.placement!.stops[state.placement!.cursor]!;
    if (movedStop.kind === "take") {
      expect(movedFrame).toContain(`take on ¶ ${movedStop.partNumber}`);
      expect(movedFrame).not.toContain(takeLabel);
    } else {
      expect(movedFrame).toContain("here · new Part");
      expect(movedFrame).toContain("prose placed");
      expect(movedFrame).not.toContain(takeLabel);
    }
    // Return to the opening Take stop for the rest of the flow.
    while (state.placement!.stops[state.placement!.cursor]?.kind !== "take"
      || (state.placement!.stops[state.placement!.cursor] as { partId?: string }).partId
        !== openingPart.id) {
      await handleOverlayAction({ action: "focus-previous" }, state, source, context);
    }

    // Esc restores the exact Aside surface with the use menu open.
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).toBe(surface);
    expect(state.placement).toBeNull();
    expect(surface.focus).toBe("notes");
    expect(surface.useMenu).toMatchObject({ noteIndex: 0, cursor: 1 });
    expect(typeof surface.useMenu?.sessionId).toBe("string");

    // Take placement: sibling under the opening Part's parent.
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");
    const beforeNodes = state.payload.nodes.length;
    await handleOverlayAction({ action: "apply" }, state, source, context);
    await context.backend.whenIdle();
    expect(state.mode).toBe("NAV");
    expect(state.placement).toBeNull();
    expect(state.payload.nodes.length).toBe(beforeNodes + 1);
    expect(state.toast).toMatch(/^placed as Part \d+$/);
    const focused = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(focused).not.toBeNull();
    expect(focused!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(focused!.node.text).toBe(answer);
    expect(focused!.node.parentId).toBe(openingPart.parentId);
    expect(state.freshLandedAt.has(focused!.id)).toBeTrue();

    // Leaf-gap placement: child of the active leaf.
    const surface2 = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "gap?", answer: "leaf gap prose" }],
      null,
      state.payload.path.at(-1)!.id
    );
    state.aside = surface2;
    state.mode = "ASIDE";
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    await handleOverlayAction({ action: "focus-next" }, state, source, context);
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("PLACE");
    // Move to the trailing leaf gap.
    while (state.placement!.stops[state.placement!.cursor]?.kind !== "leaf-gap") {
      await handleOverlayAction({ action: "focus-next" }, state, source, context);
    }
    const gapFrame = renderStoryScreen(state, { width: 80, height: 24 })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");
    expect(gapFrame).toContain("here · new Part");
    expect(gapFrame).toContain("leaf gap prose");
    expect(gapFrame.includes("take on ¶")).toBeFalse();
    const leafId = state.payload.path.at(-1)!.id;
    const pathBefore = state.payload.path.length;
    await handleOverlayAction({ action: "apply" }, state, source, context);
    await context.backend.whenIdle();
    expect(state.mode).toBe("NAV");
    expect(state.payload.path.length).toBe(pathBefore + 1);
    const leafPlaced = rowPart(createStoryViewModel(state.payload), state.focusIndex);
    expect(leafPlaced).not.toBeNull();
    expect(leafPlaced!.node.parentId).toBe(leafId);
    expect(leafPlaced!.node.instruction).toBe(FROM_ASIDE_INSTRUCTION);
    expect(leafPlaced!.node.text).toBe("leaf gap prose");
    expect(state.toast).toBe(`placed as Part ${leafPlaced!.number}`);
  });
});
