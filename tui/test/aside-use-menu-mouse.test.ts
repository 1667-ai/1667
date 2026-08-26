/**
 * Aside use-menu mouse hits and presented-frame reconciliation.
 */
import { describe, expect, test } from "bun:test";
import {
  asideAnswerRowId,
  createAsideSurface,
  isAsideV2
} from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import {
  asideUseActions,
  focusAsideUseMenuIndex,
  openAsideUseMenu
} from "../src/aside-use.js";
import { selectionAwarePartMenuAction } from "../src/selection-menu.js";
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
    previewTheme: () => undefined
  };
}

function installLegacyAside(
  state: ReturnType<typeof initialState>,
  answer: string
) {
  const surface = createAsideSurface(
    state.payload.id,
    state.payload.title,
    [{ question: "Why?", answer }]
  );
  state.aside = surface;
  state.mode = "ASIDE";
  return surface;
}

function installV2Aside(
  state: ReturnType<typeof initialState>,
  answer: string
) {
  const surface = createAsideSurface(
    state.payload.id,
    state.payload.title,
    [{
      id: "session-1",
      title: "session",
      anchor: null,
      turns: [{ id: "turn-1", q: "Why?", a: answer }]
    }],
    null,
    null,
    { v2: true }
  );
  if (!isAsideV2(surface)) throw new Error("expected v2 Aside surface");
  state.aside = surface;
  state.mode = "ASIDE";
  return surface;
}

function selectionReader(
  text: string,
  range: { start: number; end: number }
) {
  let cleared = false;
  let prevented = false;
  const selection = {
    getSelectedText: () => text,
    selectedRenderables: [{ getSelection: () => range }]
  };
  return {
    renderer: {
      getSelection: () => selection,
      clearSelection: () => { cleared = true; }
    },
    event: {
      type: "down",
      button: 2,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
      preventDefault: () => { prevented = true; }
    },
    wasCleared: () => cleared,
    wasPrevented: () => prevented
  };
}

function normalizedFrameText(lines: ReturnType<typeof renderStoryScreen>["lines"]): string {
  const panel = lines.map((line) => line
    .filter((part) => part.background === "raised" && part.role !== "compose accent")
    .map((part) => part.text)
    .join("\n"))
    .join("\n");
  return panel.length > 0 ? panel
    .replace(/[┃┏┓┗━]/gu, " ")
    .replace(/\s+/gu, " ") : frameText(lines)
    .replace(/[┃┏┓┗━]/gu, " ")
    .replace(/\s+/gu, " ");
}

function activateStoryStream(state: ReturnType<typeof initialState>): void {
  state.stream = {
    targetId: "streaming-part",
    parentId: null,
    append: true,
    startedAt: "2026-08-26T00:00:00.000Z",
    instruction: "",
    text: "partial answer"
  } as never;
}

describe("Aside use-menu mouse", () => {
  test("keeps a selected answer visibly highlighted while its use menu is open", async () => {
    const answer = "alpha bravo charlie delta echo foxtrot golf hotel";
    const width = 80;
    const height = 36;
    for (const variant of ["legacy", "v2"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const surface = variant === "legacy"
        ? installLegacyAside(state, answer)
        : installV2Aside(state, answer);
      const initialFrame = renderStoryScreen(state, { width, height });
      state.hitRows = initialFrame.derived.hitRows;
      const projection = initialFrame.derived.storySelectionProjection;
      expect(projection).not.toBeNull();
      const answerCells = projection!.flatMap((cell, index) => cell === null
        ? [] : [{ cell, index }]).filter(({ cell }) => cell.key.startsWith("aside-answer:"));
      const first = answerCells[0]!;
      const last = answerCells[15]!;
      const expected = answer.slice(first.cell.start, last.cell.end);
      const answerRow = state.hitRows.findIndex((row) => row?.target.kind === "aside-answer");
      expect(answerRow).toBeGreaterThan(-1);
      const raw = mouseToAction({
        type: "down",
        button: 2,
        x: 4,
        y: answerRow,
        modifiers: { shift: false, alt: false, ctrl: false }
      }, state);
      expect(raw?.action).toBe("open-aside-use");

      const native = selectionReader(`  ${expected}`, {
        start: first.index,
        end: last.index + 1
      });
      const decorated = selectionAwarePartMenuAction(
        native.event as never,
        raw,
        native.renderer as never,
        projection
      );
      expect(decorated?.selectionText).toBe(expected);
      expect(decorated?.selectionSpans).toEqual([{
        key: first.cell.key,
        text: answer,
        start: first.cell.start,
        end: last.cell.end
      }]);

      await handleOverlayAction(decorated!, state, source, overlayContext(state, width, height));
      const menuFrame = renderStoryScreen(state, { width, height });
      const highlightedText = menuFrame.lines.flatMap((line) => line)
        .filter((part) => part.role === "background" && part.background === "focus / accent")
        .map((part) => part.text)
        .join("");
      expect(highlightedText).toContain(expected);
      expect(surface.useMenu?.selectionText).toBe(expected);
      expect(surface.useMenu?.selectionSpans).toEqual(decorated?.selectionSpans);
      expect(surface.useMenu?.selectionSpans?.[0]?.text).toBe(answer);
    }
  });

  test("right-clicking a wrapped answer uses exact source text in legacy and v2", async () => {
    const answer = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    const width = 36;
    const height = 24;
    for (const variant of ["legacy", "v2"] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const surface = variant === "legacy"
        ? installLegacyAside(state, answer)
        : installV2Aside(state, answer);
      const context = overlayContext(state, width, height);
      const frame = renderStoryScreen(state, { width, height });
      state.hitRows = frame.derived.hitRows;

      const projection = frame.derived.storySelectionProjection;
      expect(projection).not.toBeNull();
      const stride = width + 1;
      const mapped = projection!.flatMap((cell, index) => cell === null
        ? [] : [{ cell, index }]);
      const answerCells = mapped.filter(({ cell }) => cell.key.startsWith("aside-answer:"));
      expect(answerCells.length).toBeGreaterThan(0);
      const first = answerCells[0]!;
      const firstRow = Math.floor(first.index / stride);
      const secondRowCells = answerCells.filter(({ index }) =>
        Math.floor(index / stride) > firstRow);
      expect(secondRowCells.length).toBeGreaterThan(0);
      const last = secondRowCells.at(-1)!;
      const expected = first.cell.text.slice(first.cell.start, last.cell.end);
      expect(expected).toBe(answer.slice(first.cell.start, last.cell.end));

      const answerRow = state.hitRows.findIndex((row) => row?.target.kind === "aside-answer");
      expect(answerRow).toBeGreaterThan(-1);
      const raw = mouseToAction({
        type: "down",
        button: 2,
        x: 4,
        y: answerRow,
        modifiers: { shift: false, alt: false, ctrl: false }
      }, state);
      expect(raw).toMatchObject({
        action: "open-aside-use",
        index: 0,
        rowId: asideAnswerRowId(surface, 0)
      });

      // Native terminal selection text includes the painted gutter and the
      // wrap newline. The semantic projection must remove both.
      const native = selectionReader(`  ${expected.slice(0, 12)}\n     ${expected.slice(12)}`, {
        start: first.index,
        end: last.index + 1
      });
      const decorated = selectionAwarePartMenuAction(
        native.event as never,
        raw,
        native.renderer as never,
        projection
      );
      expect(decorated?.selectionText).toBe(expected);
      expect(decorated?.selectionText).not.toContain("\n");
      expect(/^\s/u.test(decorated?.selectionText ?? "")).toBeFalse();
      expect(native.wasCleared()).toBeTrue();
      expect(native.wasPrevented()).toBeTrue();

      await handleOverlayAction(decorated!, state, source, context);
      expect(surface.useMenu?.selectionText).toBe(expected);
      expect(asideUseActions(surface.useMenu?.selectionText).map(({ id }) => id))
        .toEqual(["copy", "insert-into-compose", "insert-as-new-fact", "insert-into-story"]);

      // Copy owns the selected text, then the same menu can be reopened for
      // the local Fact editor path without losing the exact target.
      await handleOverlayAction({ action: "focus-index", index: 0 }, state, source, context);
      await handleOverlayAction({ action: "apply" }, state, source, context);
      expect(state.mode).toBe("ASIDE");
      expect(surface.useMenu).toBeNull();
      expect(state.toast).toMatch(/copied selection|no clipboard available/u);

      await handleOverlayAction({
        action: "open-aside-use",
        index: 0,
        rowId: asideAnswerRowId(surface, 0),
        selectionText: expected
      }, state, source, context);
      activateStoryStream(state);
      await handleOverlayAction({ action: "focus-index", index: 2 }, state, source, context);
      await handleOverlayAction({ action: "apply" }, state, source, context);
      expect(state.mode).toBe("EDITOR");
      expect(state.editor?.kind).toBe("fact");
      expect(state.editor?.kind === "fact" ? state.editor.composer.text : "")
        .toBe(expected);
    }
  });

  test("v2 answer identity follows an id-less turn after an earlier turn is deleted", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{
        id: "session-1",
        title: "session",
        anchor: null,
        turns: [
          { q: "first", a: "first answer" },
          { q: "later", a: "later answer" }
        ]
      }],
      null,
      null,
      { v2: true }
    );
    if (!isAsideV2(surface)) throw new Error("expected v2 Aside surface");
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 80;
    const height = 24;
    const event: FrozenMouseEvent = {
      type: "down",
      button: 2,
      x: 8,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const initialFrame = renderStoryScreen(state, { width, height });
    state.hitRows = initialFrame.derived.hitRows;
    const laterRow = state.hitRows.findIndex((row) =>
      row?.target.kind === "aside-answer" && row.target.noteIndex === 1);
    expect(laterRow).toBeGreaterThan(-1);
    const capturedEvent = { ...event, y: laterRow };
    const action = mouseToAction(capturedEvent, state);
    expect(action).toMatchObject({ action: "open-aside-use", index: 1 });
    expect(action?.rowId).toContain(":ref:");
    const laterCells = initialFrame.derived.storySelectionProjection!
      .flatMap((cell, index) => cell?.text === "later answer" ? [{ cell, index }] : []);
    const first = laterCells[0]!;
    const last = laterCells[4]!;
    const native = selectionReader("later", {
      start: first.index,
      end: last.index + 1
    });
    const selectedAction = selectionAwarePartMenuAction(
      native.event as never,
      action,
      native.renderer as never,
      initialFrame.derived.storySelectionProjection
    );
    expect(selectedAction?.selectionText).toBe("later");

    const captured: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const session = surface.sessions[surface.sessionIndex]!;
    surface.deleteUndo = {
      sessionId: session.id,
      turnIndex: 0,
      turn: session.turns[0]!
    };
    const laterTurn = session.turns[1]!;
    surface.sessions[surface.sessionIndex] = { ...session, turns: [laterTurn] };
    state.hitRows = renderStoryScreen(state, { width, height }).derived.hitRows;
    const presented: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const rebased = reconcilePresentedMouseAction({
      action: selectedAction!,
      event: capturedEvent,
      captured,
      presented,
      state
    });
    expect(rebased).toMatchObject({
      action: "open-aside-use",
      index: 0,
      rowId: action?.rowId
    });
    const sourceWithDelete = {
      ...source,
      api: {
        ...source.api,
        deleteAsideTurn: async () => ({
          schemaVersion: 2 as const,
          id: "session-1",
          title: "session",
          anchor: null,
          turns: [{ q: "later", a: "later answer" }]
        })
      }
    };
    const context = overlayContext(state, width, height);
    await handleOverlayAction(rebased!, state, sourceWithDelete, context);
    expect(surface.useMenu?.noteIndex).toBe(0);
    expect(surface.useMenu?.selectionText).toBe("later");
    expect(surface.sessions[surface.sessionIndex]?.turns[0]?.a).toBe("later answer");
    const menuFrame = renderStoryScreen(state, { width, height });
    const highlightedText = menuFrame.lines.flatMap((line) => line)
      .filter((part) => part.role === "background" && part.background === "focus / accent")
      .map((part) => part.text)
      .join("");
    expect(highlightedText).toContain("later");

    await handleOverlayAction({ action: "focus-index", index: 0 }, state, sourceWithDelete, context);
    await context.backend.settle();
    expect(surface.sessions[surface.sessionIndex]?.turns[0]).not.toBe(laterTurn);
    const settledFrame = renderStoryScreen(state, { width, height });
    const settledHighlight = settledFrame.lines.flatMap((line) => line)
      .filter((part) => part.role === "background" && part.background === "focus / accent")
      .map((part) => part.text)
      .join("");
    expect(settledHighlight).toContain("later");
  });

  test("v2 id-less answer click drops when its turn object is replaced", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{
        id: "session-1",
        title: "session",
        anchor: null,
        turns: [
          { q: "first", a: "first answer" },
          { q: "later", a: "later answer" }
        ]
      }],
      null,
      null,
      { v2: true }
    );
    if (!isAsideV2(surface)) throw new Error("expected v2 Aside surface");
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 80;
    const height = 24;
    const frame = renderStoryScreen(state, { width, height });
    state.hitRows = frame.derived.hitRows;
    const laterRow = state.hitRows.findIndex((row) =>
      row?.target.kind === "aside-answer" && row.target.noteIndex === 1);
    expect(laterRow).toBeGreaterThan(-1);
    const event: FrozenMouseEvent = {
      type: "down",
      button: 2,
      x: 8,
      y: laterRow,
      modifiers: { shift: false, alt: false, ctrl: false }
    };
    const action = mouseToAction(event, state);
    expect(action?.action).toBe("open-aside-use");
    const captured: PresentedInteraction = {
      version: 1,
      frameToken: 1,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const session = surface.sessions[surface.sessionIndex]!;
    surface.sessions[surface.sessionIndex] = {
      ...session,
      turns: [
        session.turns[0]!,
        { q: "later", a: "later answer" }
      ]
    };
    state.hitRows = renderStoryScreen(state, { width, height }).derived.hitRows;
    const presented: PresentedInteraction = {
      version: 2,
      frameToken: 2,
      interactive: true,
      storyId: state.payload.id,
      state: captureMouseActionState(state)
    };
    const stale = reconcilePresentedMouseAction({
      action: action!,
      event,
      captured,
      presented,
      state
    });
    expect(stale).toBeNull();
    expect(surface.useMenu).toBeNull();
  });

  test("full-answer Fact action and wrapped menu rows fit narrow and wide views", async () => {
    const actions = asideUseActions();
    expect(actions.map(({ id }) => id)).toEqual([
      "insert-into-compose", "insert-into-story", "insert-as-new-fact"
    ]);
    const answer = Array.from({ length: 900 }, () => "answer-word").join(" ");
    for (const [width, height] of [[24, 16], [120, 24]] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const surface = installLegacyAside(state, answer);
      const context = overlayContext(state, width, height);
      await handleOverlayAction({ action: "cycle" }, state, source, context);
      await handleOverlayAction({ action: "open-selected" }, state, source, context);
      expect(surface.useMenu).not.toBeNull();

      for (const [index, action] of actions.entries()) {
        focusAsideUseMenuIndex(surface, index);
        const frame = renderStoryScreen(state, { width, height });
        const text = normalizedFrameText(frame.lines);
        expect(text).toContain(action.name);
        expect(text).toContain(action.description);
        expect(frame.lines.every((line) => visibleWidth(plainLine(line)) <= width)).toBeTrue();
      }
      if (width >= 100) {
        const title = normalizedFrameText(renderStoryScreen(state, { width, height }).lines);
        expect(title).toContain("use answer · 900 words");
      }
    }

    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = installLegacyAside(state, answer);
    const context = overlayContext(state, 120, 24);
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    activateStoryStream(state);
    focusAsideUseMenuIndex(surface, 2);
    await handleOverlayAction({ action: "apply" }, state, source, context);
    expect(state.mode).toBe("EDITOR");
    expect(state.editor?.kind).toBe("fact");
    expect(state.editor?.kind === "fact" ? state.editor.composer.text : "")
      .toBe(answer);
  });

  test("wraps a very large selected menu and windows whole blocks at tiny heights", () => {
    const selected = Array.from({ length: 450 }, () => "selected-word").join(" ");
    const actions = asideUseActions(selected);

    for (const [width, height] of [[24, 16], [120, 24]] as const) {
      const source = demoAppSource();
      const state = initialState(source, false);
      const surface = installLegacyAside(state, "short answer");
      expect(openAsideUseMenu(surface, 0, 0, selected)).toBeTrue();

      for (const [index, action] of actions.entries()) {
        focusAsideUseMenuIndex(surface, index);
        const frame = renderStoryScreen(state, { width, height });
        const text = normalizedFrameText(frame.lines);
        expect(text).toContain(action.name);
        expect(text).toContain(action.description);
        expect(frame.lines.every((line) => visibleWidth(plainLine(line)) <= width)).toBeTrue();
      }
      if (width >= 100) {
        expect(normalizedFrameText(renderStoryScreen(state, { width, height }).lines))
          .toContain("use selection · 450 words");
      }
    }

    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = installLegacyAside(state, "short answer");
    expect(openAsideUseMenu(surface, 0, 0, selected)).toBeTrue();
    const frame = renderStoryScreen(state, { width: 24, height: 8 });
    const text = normalizedFrameText(frame.lines);
    expect(text).toContain("use ↑↓");
    expect(frame.lines.every((line) => visibleWidth(plainLine(line)) <= 24)).toBeTrue();
    const listTargets = frame.derived.hitRows.flatMap((row) =>
      row?.overrides?.map(({ target }) => target).filter((target) => target.kind === "list") ?? []);
    expect(listTargets.length).toBeGreaterThan(0);
    expect(listTargets.every((target) => target.kind === "list" && target.index === 0)).toBeTrue();
  });

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
