/**
 * Stable Side Note wrap widths when focus moves after history scroll.
 */
import { describe, expect, test } from "bun:test";
import { createAsideSurface } from "../src/aside-surface.js";
import { demoAppSource } from "../src/demo.js";
import { initialState } from "../src/app.js";
import { handleOverlayAction } from "../src/overlay-actions.js";
import { ActionRuntime } from "../src/action-runtime.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { renderStoryScreen } from "../src/screens/story.js";

function overlayContext(
  state: ReturnType<typeof initialState>,
  width: number,
  height: number
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

describe("Aside note wrap stability under focus change", () => {
  test("PageDown/wheel keeps focused marker and Enter target visible after wrap", async () => {
    // Long answers reflow when prefix width changes; equal-width prefixes
    // keep the newly focused note on-screen after scroll moves selection.
    const long = (label: string) =>
      `${label} ${"wrapword ".repeat(40)}end-${label}`;
    const notes = Array.from({ length: 8 }, (_, index) => ({
      question: `wrap-q-${index} ${"q ".repeat(20)}`,
      answer: long(`wrap-a-${index}`)
    }));
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(state.payload.id, state.payload.title, notes);
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 36;
    const height = 14;
    const context = overlayContext(state, width, height);
    const frameText = () => renderStoryScreen(state, { width, height })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    expect(surface.noteCursor).toBe(notes.length - 1);

    // Page toward older notes: each focus change must keep ▸ Q: and Enter target
    // identical and on-screen (stable wrap + reveal after cursor move).
    let previousCursor = surface.noteCursor;
    for (let page = 0; page < 5; page += 1) {
      await handleOverlayAction({ action: "scroll-up" }, state, source, context);
      if (surface.noteCursor === previousCursor) continue;
      previousCursor = surface.noteCursor;
      const frame = frameText();
      expect(frame).toContain("▸ Q:");
      expect(frame).toContain(`wrap-q-${surface.noteCursor}`);
      expect(frame).toContain(`wrap-a-${surface.noteCursor}`);
    }
    expect(surface.noteCursor).toBeLessThan(notes.length - 1);

    // Wheel/line down that changes selection must also keep the marker visible.
    previousCursor = surface.noteCursor;
    for (let step = 0; step < 20; step += 1) {
      await handleOverlayAction({ action: "scroll-line-down" }, state, source, context);
      if (surface.noteCursor !== previousCursor) break;
    }
    expect(surface.noteCursor).not.toBe(previousCursor);
    const frameAfterFocusChange = frameText();
    expect(frameAfterFocusChange).toContain("▸ Q:");
    expect(frameAfterFocusChange).toContain(`wrap-q-${surface.noteCursor}`);

    const beforeEnter = surface.noteCursor;
    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu).not.toBeNull();
    expect(surface.useMenu!.noteIndex).toBe(beforeEnter);
    expect(surface.notes[surface.useMenu!.noteIndex]!.question)
      .toBe(notes[beforeEnter]!.question);
  });

  test("one tall note marks a wrap continuation after Q and first A scroll away", async () => {
    // One paragraph so later rows are wrap continuations (pad spaces), not "A:".
    const answer = Array.from(
      { length: 80 },
      (_, index) => `wrapword${index}`
    ).join(" ");
    const notes = [{
      question: "tall-note-question that may wrap once",
      answer
    }];
    const source = demoAppSource();
    const state = initialState(source, false);
    const surface = createAsideSurface(state.payload.id, state.payload.title, notes);
    state.aside = surface;
    state.mode = "ASIDE";
    const width = 36;
    const height = 12;
    const context = overlayContext(state, width, height);
    const frameText = () => renderStoryScreen(state, { width, height })
      .lines.map((line) => line.map((part) => part.text).join("")).join("\n");

    await handleOverlayAction({ action: "cycle" }, state, source, context);
    expect(surface.focus).toBe("notes");
    expect(surface.noteCursor).toBe(0);
    // Labelled first content row still gets ▸ Q: when it is first visible.
    expect(frameText()).toContain("▸ Q:");

    // Scroll past the question and the paragraph's first "  A:" labelled row.
    for (let step = 0; step < 40; step += 1) {
      await handleOverlayAction({ action: "scroll-line-down" }, state, source, context);
    }
    expect(surface.noteCursor).toBe(0);
    const frame = frameText();
    expect(frame).not.toContain("tall-note-question");
    expect(frame).not.toContain("▸ Q:");
    expect(frame).not.toContain("▸ A:");
    // First visible owned row is a wrap continuation: still shows ▸.
    expect(frame).toContain("▸");
    expect(frame).toMatch(/wrapword\d+/);

    await handleOverlayAction({ action: "open-selected" }, state, source, context);
    expect(surface.useMenu).not.toBeNull();
    expect(surface.useMenu!.noteIndex).toBe(0);
    expect(surface.notes[0]!.question).toContain("tall-note-question");
  });
});
