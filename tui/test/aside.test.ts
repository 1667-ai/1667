import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import type { KeyEvent, MouseEvent } from "@opentui/core";
import {
  createAsideSurface,
  ASIDE_INPUT_PLACEHOLDER,
  ASIDE_SAVED_NOTICE,
  asideHeaderLine
} from "../src/aside-surface.js";
import {
  asideFooterHint,
  closeAside,
  openAside,
  renderAsideFrame,
  sendAsideQuestion,
  clearAsideSurface,
  stopAsideAsk
} from "../src/aside-actions.js";
import { parseAsideComposerInput } from "../src/aside-parse.js";
import { commandPaletteModel } from "../src/command-model.js";
import { pasteInto, resolveKey } from "../src/keys.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import type { StoryApi } from "../src/api.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { composeAction } from "../src/story-actions.js";
import { openDirectComposer } from "../src/composer-ownership.js";
import { moveComposerTo, setComposerText } from "../src/composer-model.js";
import { visibleWidth } from "../src/screens/story/frame.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { activeTextComposer, openTextActions } from "../src/text-actions.js";
import { mouseToAction } from "../src/mouse-actions.js";

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
    previewTheme: () => undefined,
    updateChecks: INERT_UPDATE_CHECK_LIFECYCLE
  };
}

describe("Aside TUI contract", () => {
  test("header, notice, and input placeholder match the product strings", () => {
    expect(asideHeaderLine("Lantern Story")).toBe("ASIDE · Lantern Story · non-canon");
    expect(ASIDE_SAVED_NOTICE).toBe(
      "Side Notes are saved with this story. They never enter story prompts."
    );
    expect(ASIDE_INPUT_PLACEHOLDER).toBe("Ask about this story");
    const surface = createAsideSurface("s1", "Lantern Story");
    const lines = renderAsideFrame(surface, 80, 24);
    expect(lines[0]).toBe("ASIDE · Lantern Story · non-canon");
    expect(lines[1]).toBe(ASIDE_SAVED_NOTICE);
    expect(lines.some((line) => line.includes("Ask about this story"))).toBeTrue();
  });

  test("wraps long history rows to the viewport width", () => {
    const surface = createAsideSurface("s1", "Lantern Story", [{
      question: "question ".repeat(12).trim(),
      answer: "answer ".repeat(18).trim()
    }]);
    const lines = renderAsideFrame(surface, 24, 40);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBeTrue();
    expect(lines.some((line) => line.includes("question question"))).toBeTrue();
    expect(lines.some((line) => line.includes("answer answer"))).toBeTrue();
  });

  test("PageUp reaches older saved history while the newest view follows the tail", async () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      question: `older-${index}`,
      answer: `answer-${index}`
    }));
    const surface = createAsideSurface("s1", "Lantern Story", notes);
    const source = demoAppSource();
    const state = initialState(source, false);
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 40;
    const height = 12;
    const newest = renderAsideFrame(surface, width, height).join("\n");
    expect(newest).toContain("older-7");
    expect(newest).not.toContain("older-0");
    expect(resolveKey(key("pageup"), "ASIDE").action).toBe("scroll-up");
    expect(resolveKey(key("pagedown"), "ASIDE").action).toBe("scroll-down");
    expect(resolveKey(key("up", { shift: true }), "ASIDE").action).toBe("scroll-line-up");
    expect(resolveKey(key("up"), "ASIDE").action).toBe("cursor-up");
    for (let page = 0; page < 8; page += 1) {
      await handleOverlayAction(
        resolveKey(key("pageup"), "ASIDE"),
        state,
        source,
        overlayContext(state, width, height)
      );
    }
    const oldest = renderAsideFrame(surface, width, height).join("\n");
    expect(oldest).toContain("older-0");
    expect(surface.scrollTop).toBe(0);

    for (let page = 0; page < 8; page += 1) {
      await handleOverlayAction(
        resolveKey(key("pagedown"), "ASIDE"),
        state,
        source,
        overlayContext(state, width, height)
      );
    }
    expect(surface.scrollTop).toBeNull();
    surface.notes.push({ question: "new-tail", answer: "followed" });
    expect(renderAsideFrame(surface, width, height).join("\n")).toContain("new-tail");
  });

  test("the mouse wheel scrolls Side Note history", async () => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      question: `older-${index}`,
      answer: `answer-${index}`
    }));
    const surface = createAsideSurface("s1", "Lantern Story", notes);
    const source = demoAppSource();
    const state = initialState(source, false);
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 40;
    const height = 12;
    const wheelUp = {
      type: "scroll",
      button: 0,
      x: 20,
      y: 5,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: { direction: "up" }
    } as unknown as MouseEvent;

    const action = mouseToAction(wheelUp, state);
    expect(action).toEqual({ action: "scroll-line-up" });
    await handleOverlayAction(
      action!,
      state,
      source,
      overlayContext(state, width, height)
    );

    expect(surface.scrollTop).not.toBeNull();

    openTextActions(state);
    expect(mouseToAction(wheelUp, state)).toEqual({ action: "focus-previous" });
  });

  test("ASIDE mode: Enter sends, Shift+Enter newlines, Esc cancels", () => {
    expect(resolveKey(key("return"), "ASIDE").action).toBe("send");
    expect(resolveKey(key("return", { shift: true }), "ASIDE").action).toBe("newline");
    expect(resolveKey(key("escape"), "ASIDE").action).toBe("cancel");
    expect(resolveKey(key("v", { ctrl: true }), "ASIDE").action).toBe("paste-clipboard");
    expect(resolveKey(key("v", { super: true }), "ASIDE").action).toBe("paste-clipboard");
  });

  test("Aside uses shared selection and undo editing", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface("s1", "Lantern Story");
    state.aside = surface;
    state.mode = "ASIDE";
    setComposerText(surface.composer, "first\nsecond");

    await handleOverlayAction(
      resolveKey(key("left", { shift: true }), "ASIDE"),
      state,
      source,
      overlayContext(state)
    );
    await handleOverlayAction(
      { action: "input", text: "X" },
      state,
      source,
      overlayContext(state)
    );
    expect(surface.composer.text).toBe("first\nseconX");

    await handleOverlayAction(
      { action: "undo-edit" },
      state,
      source,
      overlayContext(state)
    );
    expect(surface.composer.text).toBe("first\nsecond");
  });

  test("bracketed paste sanitizes controls and keeps Aside newlines", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface("s1", "Lantern Story");
    state.aside = surface;
    state.mode = "ASIDE";
    setComposerText(surface.composer, "before");

    expect(pasteInto(state, "first\r\nsecond\u0000\u001bthird")).toBeTrue();
    expect(surface.composer.text).toBe("beforefirst\nsecondthird");
  });

  test("Command Palette keeps Aside closed in the predecessor release", () => {
    const model = commandPaletteModel("aside", false, {
      connectionDown: false,
      requestActive: false,
      hasProse: true,
      lineTagged: false,
      canRewriteSelection: false,
      asideEntryPointsOpen: false
    });
    const match = model.selectable.find((entry) => entry.command.id === "aside");
    expect(match).toBe(undefined);
  });

  test("Direct composer /aside shortcuts", () => {
    expect(parseAsideComposerInput("/aside")).toEqual({ kind: "open" });
    expect(parseAsideComposerInput("/aside How could this conflict become personal?")).toEqual({
      kind: "open-and-ask",
      question: "How could this conflict become personal?"
    });
    expect(parseAsideComposerInput("//aside stays prose")).toEqual({ kind: "none" });
  });

  test("closed /aside keeps the Direct composer draft", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(openDirectComposer(state)).toBeTrue();
    setComposerText(state.composer, "/aside keep this draft");

    await composeAction(
      { action: "send" },
      state,
      source,
      overlayContext(state),
      { asideEntryPointsOpen: false }
    );

    expect(state.mode).toBe("COMPOSE");
    expect(state.composer.text).toBe("/aside keep this draft");
    expect(state.toast).toBe("Aside is not available in this release");
  });

  test("failed /aside load keeps the Direct draft and explicit activation opens", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(openDirectComposer(state)).toBeTrue();
    setComposerText(state.composer, "/aside keep this draft");
    const failingApi: StoryApi = {
      ...source.api,
      getAside: async () => { throw new Error("Aside load failed"); }
    };
    const failingSource = { ...source, api: failingApi };

    await composeAction(
      { action: "send" },
      state,
      failingSource,
      overlayContext(state),
      { asideEntryPointsOpen: true }
    );

    expect(state.mode).toBe("COMPOSE");
    expect(state.aside).toBe(null);
    expect(state.composer.text).toBe("/aside keep this draft");
    expect(state.toast).toBe("Aside load failed");

    const workingApi: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: [] })
    };
    const workingSource = { ...source, api: workingApi };
    await composeAction(
      { action: "send" },
      state,
      workingSource,
      overlayContext(state),
      { asideEntryPointsOpen: true }
    );
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).not.toBe(null);
    expect(state.composer.text).toBe("");
  });

  test("Aside input uses composer caret, selection projection, and copy ownership", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface("s1", "Lantern Story");
    state.aside = surface;
    state.mode = "ASIDE";
    setComposerText(surface.composer, "alpha beta");
    moveComposerTo(surface.composer, 0);
    moveComposerTo(surface.composer, 5, true);

    const frame = renderStoryScreen(state, { width: 80, height: 24 });
    const projection = frame.derived.composerSelectionProjection;
    expect(projection).not.toBe(null);
    const selectedCells = projection!.filter((cell) => cell !== null && cell.start < 5);
    expect(selectedCells).toHaveLength(5);
    expect(selectedCells.every((cell) => cell !== null && cell.start < cell.end)).toBeTrue();
    expect(activeTextComposer(state)).toBe(surface.composer);
    const segments = frame.lines.flat();
    expect(segments.some((part) => part.role === "background"
      && part.background === "compose accent")).toBeTrue();
    moveComposerTo(surface.composer, 5);
    const caretFrame = renderStoryScreen(state, { width: 80, height: 24 });
    expect(caretFrame.lines.flat().some((part) => part.background === "compose accent"
      && part.composerStart === 5)).toBeTrue();
  });

  test("notes focus withholds Aside composer ownership until a prompt click", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(
      state.payload.id,
      state.payload.title,
      [{ question: "Why?", answer: "Because." }]
    );
    surface.focus = "notes";
    surface.noteCursor = 0;
    state.aside = surface;
    state.mode = "ASIDE";
    const context = overlayContext(state, 80, 24);

    // Before the prompt click, text ownership is null and right-click refuses.
    expect(activeTextComposer(state)).toBeNull();
    const notesFrame = renderStoryScreen(state, { width: 80, height: 24 });
    state.hitRows = notesFrame.derived.hitRows;
    let composerHit: { x: number; y: number } | null = null;
    for (let y = 0; y < state.hitRows.length; y += 1) {
      const row = state.hitRows[y];
      if (row?.target.kind !== "composer") continue;
      composerHit = { x: Math.min(40, Math.max(0, row.right - 1)), y };
      break;
    }
    expect(composerHit).not.toBeNull();
    const rightClick = mouseToAction({
      type: "down",
      button: 2,
      x: composerHit!.x,
      y: composerHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    }, state);
    expect(rightClick).toBeNull();
    openTextActions(state);
    expect(state.textActions).toBeNull();

    // Left-click on the visible prompt claims composer focus.
    const compose = mouseToAction({
      type: "down",
      button: 0,
      x: composerHit!.x,
      y: composerHit!.y,
      modifiers: { shift: false, alt: false, ctrl: false }
    }, state);
    expect(compose).toEqual({ action: "compose" });
    await handleOverlayAction(compose!, state, source, context);
    expect(surface.focus).toBe("composer");
    expect(activeTextComposer(state)).toBe(surface.composer);

    // Subsequent text and paste target the Aside composer.
    await handleOverlayAction({ action: "input", text: "typed " }, state, source, context);
    expect(surface.composer.text).toBe("typed ");
    expect(pasteInto(state, "paste")).toBeTrue();
    expect(surface.composer.text).toBe("typed paste");

    // Esc/Tab ladder still moves notes → composer → leave.
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    expect(activeTextComposer(state)).toBeNull();
    await handleOverlayAction({ action: "cancel" }, state, source, context);
    expect(surface.focus).toBe("composer");
    expect(activeTextComposer(state)).toBe(surface.composer);

    // Use menu owns the surface: compose click does not steal focus.
    await handleOverlayAction({ action: "cycle" }, state, source, context);
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu).not.toBeNull();
    expect(activeTextComposer(state)).toBeNull();
    await handleOverlayAction({ action: "compose" }, state, source, context);
    expect(surface.useMenu).not.toBeNull();
    expect(surface.focus).toBe("notes");
    expect(activeTextComposer(state)).toBeNull();
  });

  test("failed ask restores the question; successful ask appends a Side Note", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let fail = true;
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: [] }),
      askAside: async (_id, question, onDelta) => {
        if (fail) throw new Error("provider failed");
        onDelta("Answer text.");
        return { notes: [{ question, answer: "Answer text." }] };
      },
      clearAside: async () => state.payload
    };
    await openAside(state, api, { entryPointsOpen: true });
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).not.toBeNull();

    await sendAsideQuestion(state, api, "Why the lantern?");
    expect(state.aside!.composer.text).toBe("Why the lantern?");
    expect(state.aside!.notes).toHaveLength(0);
    expect(state.aside!.busy).toBeFalse();

    fail = false;
    await sendAsideQuestion(state, api, "Why the lantern?");
    expect(state.aside!.notes).toHaveLength(1);
    expect(state.aside!.composer.text).toBe("");
    expect(state.aside!.notes[0]!.answer).toBe("Answer text.");
  });

  test("stopped ask restores the question and saves nothing", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: [] }),
      askAside: async () => null,
      clearAside: async () => state.payload
    };
    await openAside(state, api, { entryPointsOpen: true });
    await sendAsideQuestion(state, api, "Should not save");
    expect(state.aside!.notes).toHaveLength(0);
    expect(state.aside!.composer.text).toBe("Should not save");
  });

  test("clear-all requires confirmation", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let cleared = false;
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({
        notes: [{ question: "Q?", answer: "A." }]
      }),
      askAside: async () => ({ notes: [] }),
      clearAside: async () => {
        cleared = true;
        return state.payload;
      }
    };
    await openAside(state, api, { entryPointsOpen: true });
    expect(state.aside!.notes).toHaveLength(1);
    await clearAsideSurface(state, api);
    expect(cleared).toBeFalse();
    expect(state.aside!.confirmClear).toBeTrue();
    await clearAsideSurface(state, api);
    expect(cleared).toBeTrue();
    expect(state.aside!.notes).toHaveLength(0);
    expect(state.aside!.confirmClear).toBeFalse();
  });

  test("Clear replay reloads a concurrent newer Side Note", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const oldNote = { question: "Old?", answer: "Old answer." };
    const newerNote = { question: "New?", answer: "New answer." };
    let durableNotes = [oldNote];
    let clearAttempts = 0;
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: durableNotes }),
      clearAside: async () => {
        clearAttempts += 1;
        if (clearAttempts === 1) {
          durableNotes = [];
          throw new Error("lost Clear response");
        }
        return { ...state.payload, hasAside: true };
      }
    };

    await openAside(state, api, { entryPointsOpen: true });
    await clearAsideSurface(state, api);
    await clearAsideSurface(state, api);
    expect(state.aside!.notes).toEqual([oldNote]);

    // Another client adds a note before the original Clear is replayed.
    durableNotes = [newerNote];
    await clearAsideSurface(state, api);
    await clearAsideSurface(state, api);

    expect(clearAttempts).toBe(2);
    expect(state.aside!.notes).toEqual([newerNote]);
  });

  test("confirmed Clear is non-cancellable while its request is pending", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let resolveClear!: (payload: typeof state.payload) => void;
    const pendingClear = new Promise<typeof state.payload>((resolve) => { resolveClear = resolve; });
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: [{ question: "Q?", answer: "A." }] }),
      clearAside: async () => pendingClear
    };
    const sourceWithApi = { ...source, api };
    await openAside(state, api, { entryPointsOpen: true });
    const context = overlayContext(state, 80, 24);
    setComposerText(state.aside!.composer, "/clear");

    await handleOverlayAction({ action: "send" }, state, sourceWithApi, context);
    expect(state.aside!.confirmClear).toBeTrue();
    await handleOverlayAction({ action: "send" }, state, sourceWithApi, context);
    await Promise.resolve();

    expect(state.aside!.busy).toBeTrue();
    expect(state.aside!.confirmClear).toBeFalse();
    expect(asideFooterHint(state.aside!)).toBe("Clearing…");
    const frame = renderAsideFrame(state.aside!, 80, 24).join("\n");
    expect(frame).toContain("Clearing…");
    expect(frame).not.toContain("Esc");

    await handleOverlayAction({ action: "cancel" }, state, sourceWithApi, context);
    expect(state.mode).toBe("ASIDE");
    expect(state.aside!.busy).toBeTrue();
    expect(state.abort).toBeNull();

    resolveClear(state.payload);
    await context.backend.whenIdle();
    expect(state.aside!.busy).toBeFalse();
  });

  test("editing after Clear confirmation disarms destructive confirmation", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let cleared = false;
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: [] }),
      askAside: async (_storyId, question) => ({
        notes: [{ question, answer: "answer" }]
      }),
      clearAside: async () => {
        cleared = true;
        return state.payload;
      }
    };
    const sourceWithApi = { ...source, api };
    await openAside(state, api, { entryPointsOpen: true });
    const context = overlayContext(state);

    await handleOverlayAction({ action: "input", text: "/clear" }, state, sourceWithApi, context);
    await handleOverlayAction({ action: "send" }, state, sourceWithApi, context);
    expect(state.aside!.confirmClear).toBeTrue();
    expect(state.aside!.composer.text).toBe("");

    await handleOverlayAction({ action: "input", text: "new question" }, state, sourceWithApi, context);
    expect(state.aside!.confirmClear).toBeFalse();
    expect(state.aside!.composer.text).toBe("new question");
    await handleOverlayAction({ action: "send" }, state, sourceWithApi, context);
    await context.backend.whenIdle();

    expect(cleared).toBeFalse();
    expect(state.aside!.notes[0]!.question).toBe("new question");
  });

  test("bracketed paste after Clear confirmation becomes a question", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let cleared = false;
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: [] }),
      askAside: async (_storyId, question) => ({
        notes: [{ question, answer: "answer" }]
      }),
      clearAside: async () => {
        cleared = true;
        return state.payload;
      }
    };
    const sourceWithApi = { ...source, api };
    await openAside(state, api, { entryPointsOpen: true });
    const context = overlayContext(state);

    await handleOverlayAction({ action: "input", text: "/clear" }, state, sourceWithApi, context);
    await handleOverlayAction({ action: "send" }, state, sourceWithApi, context);
    expect(state.aside!.confirmClear).toBeTrue();

    expect(pasteInto(state, "pasted question")).toBeTrue();
    expect(state.aside!.confirmClear).toBeFalse();
    expect(state.aside!.composer.text).toBe("pasted question");
    await handleOverlayAction({ action: "send" }, state, sourceWithApi, context);
    await context.backend.whenIdle();

    expect(cleared).toBeFalse();
    expect(state.aside!.notes[0]!.question).toBe("pasted question");
  });

  test("Esc while busy aborts via overlay path; idle Esc leaves Aside", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const api: StoryApi = {
      ...source.api,
      getAside: async () => ({ notes: [] }),
      askAside: async (_id, _q, _onDelta, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        await gate;
        if (signal.aborted) return null;
        return { notes: [{ question: "Q", answer: "A" }] };
      },
      clearAside: async () => state.payload
    };
    const sourceWithApi = { ...source, api };
    await openAside(state, api, { entryPointsOpen: true });
    expect(state.mode).toBe("ASIDE");
    const pending = sendAsideQuestion(state, api, "In flight?");
    await Promise.resolve();
    expect(state.aside!.busy).toBeTrue();
    expect(state.abort?.kind).toBe("generation");

    // Overlay Esc while busy: abort only; stay on Aside.
    const handled = await handleOverlayAction(
      { action: "cancel" },
      state,
      sourceWithApi,
      overlayContext(state)
    );
    expect(handled).toBeTrue();
    // Second stop is a no-op once the controller is already aborted.
    expect(stopAsideAsk(state)).toBeFalse();
    release();
    await pending;
    expect(aborted).toBeTrue();
    expect(state.aside!.composer.text).toBe("In flight?");
    expect(state.aside!.notes).toHaveLength(0);
    expect(state.mode).toBe("ASIDE");
    expect(state.aside).not.toBeNull();
    expect(state.abort).toBeNull();
    expect(state.aside!.busy).toBeFalse();

    // Idle Esc returns to Write.
    await handleOverlayAction(
      { action: "cancel" },
      state,
      sourceWithApi,
      overlayContext(state)
    );
    expect(state.mode).toBe("NAV");
    expect(state.aside).toBeNull();
  });
});
