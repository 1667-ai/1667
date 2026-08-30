import { expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";
import { factWithText } from "./fact-fixture.js";

const ESC = "";

function render(state: ReturnType<typeof initialState>, width: number, height = 36): string {
  return frameText(
    renderStoryScreen(state, { width, height, wrapCache: createWrapCache<ProseStyle>() }).lines
  );
}

test("the reading column draws an escape sequence in story prose as a control mark", () => {
  const state = initialState(demoAppSource(), true);
  // The drawn prose is the path, not the node summaries. Only part of the path
  // is inside the viewport, so every part carries the sequence.
  for (const part of state.payload.path) {
    part.text = `the paper: ${ESC}[2J${ESC}[H — do not walk the cliff road`;
  }

  const frame = render(state, 120);

  expect(frame).toContain("▪[2J▪[H");
  expect(frame).not.toContain(ESC);
});

test("the facts panel draws an escape sequence in a fact tag and text as a control mark", () => {
  const state = initialState(demoAppSource(), true);
  const fact = state.payload.facts[0]!;
  state.payload.facts = [factWithText(fact,
    `A lighthouse${ESC}[2J on the north cape\nWinter. The keeper is Maren.`, {
      id: "fact-esc",
      tag: `tag${ESC}[31m`
    })];
  state.mode = "FACTS";
  state.facts = {
    cursor: 0,
    query: "",
    chip: 0,
    selectedTag: null,
    filtering: false,
    deleteArmedId: null
  };

  const frame = render(state, 120);

  expect(frame).toContain("▪");
  expect(frame).not.toContain(ESC);
});

test("the facts rail draws an escape sequence in a fact name and tag as a control mark", () => {
  const state = initialState(demoAppSource(), true);
  const fact = state.payload.facts[0]!;
  state.payload.facts = [factWithText(fact,
    `A lighthouse${ESC}[2J on the north cape\nWinter. The keeper is Maren.`, {
      id: "fact-esc",
      tag: `tag${ESC}[31m`
    })];

  // The rail needs RAIL_MIN_COLUMNS (138) before it is drawn at all.
  const frame = render(state, 140);

  expect(frame).toContain("▪");
  expect(frame).not.toContain(ESC);
});
