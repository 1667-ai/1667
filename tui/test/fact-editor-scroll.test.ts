import { describe, expect, test } from "bun:test";
import type { MouseEvent } from "@opentui/core";
import { dispatch, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { openFactEditor } from "../src/editor-open.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { editorHarness } from "./editor-harness.js";
import { createWrapCache } from "../src/wrap.js";

const TERMINAL_WIDTH = 100;
const BODY_LINES = 60;

/** The Fact editor puts the cursor at the end of the text, so a Fact that is
 *  taller than the screen opens scrolled to its last line. The editor adds a
 *  row for every Fact field above the body, and those rows must come out of
 *  the body's own height. When they do not, the body scrolls against rows the
 *  terminal never shows: the last line, the cursor, and the footer all render
 *  below the bottom of the screen, and the editor looks frozen. */
function openLongFact(height: number): string[] {
  const { state } = editorHarness();
  const fact = state.payload.facts[0]!;
  const text = Array.from(
    { length: BODY_LINES },
    (_, index) => `line ${index + 1} of the long fact body`
  ).join("\n");
  openFactEditor(state, { ...fact, text });
  return frameText(
    renderStoryScreen(state, { width: TERMINAL_WIDTH, height }).lines
  ).split("\n");
}

describe("Fact editor scrolling", () => {
  test("a Fact taller than the screen opens on its last line", () => {
    const lines = openLongFact(24);
    expect(lines.some((line) => line.includes(`line ${BODY_LINES} of the long fact body`)))
      .toBeTrue();
  });

  test("a Fact taller than the screen keeps the editor footer visible", () => {
    expect(openLongFact(24).join("\n")).toContain("ctrl+s save");
  });

  test("a Fact taller than the screen opens on its last line at any height", () => {
    for (const height of [16, 24, 40]) {
      const lines = openLongFact(height);
      expect(lines.length <= height).toBeTrue();
      expect(lines.some((line) => line.includes(`line ${BODY_LINES} of the long fact body`)))
        .toBeTrue();
    }
  });

  test("the mouse wheel scrolls the Fact body without moving header focus", async () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    const fact = state.payload.facts[0]!;
    const text = Array.from(
      { length: BODY_LINES },
      (_, index) => `line ${index + 1} of the long fact body`
    ).join("\n");
    openFactEditor(state, { ...fact, text });
    const width = TERMINAL_WIDTH;
    const height = 24;
    const render = () => {
      const frame = renderStoryScreen(state, { width, height });
      Object.assign(state, frame.derived);
      return frame;
    };
    const wheelUp = {
      type: "scroll",
      button: 0,
      x: 40,
      y: 12,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: { direction: "up" }
    } as unknown as MouseEvent;

    const before = render();
    const start = before.derived.editorScrollTop;
    const cursor = state.editor?.composer.cursor;
    const anchor = state.editor?.composer.anchor;
    const action = mouseToAction(wheelUp, state);
    expect(action).toEqual({ action: "scroll-line-up" });
    for (let tick = 0; tick < 16; tick += 1) {
      await dispatch(
        action!,
        state,
        source,
        createWrapCache(),
        () => {},
        async () => {},
        () => {},
        { width, height } as never
      );
    }
    const after = render();

    const editor = state.editor;
    expect(editor?.kind).toBe("fact");
    if (editor?.kind !== "fact") throw new Error("Fact editor closed during wheel scroll");
    expect(editor.focus).toBe("body");
    expect(editor.composer.cursor).toBe(cursor);
    expect(editor.composer.anchor).toBe(anchor);
    expect(after.derived.editorScrollTop).toBeLessThan(start);
  });
});
