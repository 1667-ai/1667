import { describe, expect, test } from "bun:test";
import { openFactEditor } from "../src/editor-open.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { editorHarness } from "./editor-harness.js";

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
});
