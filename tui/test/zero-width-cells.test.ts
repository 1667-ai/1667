import { expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { createComposer } from "../src/composer-model.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

// Standalone zero-width format characters the projection keeps and the
// terminal draws in zero cells: ZWSP, ZWJ, LRM, the word joiner, and the
// Arabic letter mark. U+FEFF joins them only at a part start, because the
// word counter reads it as a separator.
const WEAVE = ["\u200B", "\u200D", "\u200E", "\u2060", "\u061C"];
const STRIP = /[\u200B\u200D\u200E\u2060\u061C\uFEFF]/gu;

function render(state: ReturnType<typeof initialState>, width: number, height = 36): string {
  return frameText(
    renderStoryScreen(state, { width, height, wrapCache: createWrapCache<ProseStyle>() }).lines
  );
}

/** Weave one zero-width format character into the middle of every long word. */
function laced(text: string): string {
  let next = 0;
  return text
    .split(" ")
    .map((word) => {
      if (word.length < 4) return word;
      const mark = WEAVE[next % WEAVE.length]!;
      next += 1;
      return word.slice(0, 2) + mark + word.slice(2);
    })
    .join(" ");
}

test("zero-width format characters move no column in the reading column", () => {
  const control = initialState(demoAppSource(), true);
  const state = initialState(demoAppSource(), true);
  for (const [index, part] of state.payload.path.entries()) {
    part.text = `\uFEFF${laced(control.payload.path[index]!.text)}`;
  }

  const frame = render(state, 120);
  const controlFrame = render(control, 120);

  // The characters are kept and drawn — and they occupy no cell, so the
  // frame matches the control column for column once they are stripped.
  expect(frame).not.toBe(controlFrame);
  expect(frame.replace(STRIP, "")).toBe(controlFrame);
});

test("zero-width format characters move no column in the facts panel or the facts rail", () => {
  const factText = "A lighthouse on the north cape\nWinter. The keeper is Maren.";
  const build = (lace: boolean) => {
    const state = initialState(demoAppSource(), true);
    const fact = state.payload.facts[0]!;
    // Keyed with no keys: the fact never joins the request, so the context
    // meter's token estimate cannot differ with the extra stored characters.
    // The panel and the rail still draw the tag and the text.
    state.payload.facts = [{
      ...fact,
      id: "fact-zw",
      tag: lace ? "ca\u200Bnon" : "canon",
      text: lace ? laced(factText) : factText,
      activation: "keyed",
      keys: []
    }];
    state.mode = "FACTS";
    state.facts = {
      cursor: 0,
      query: "",
      chip: 0,
      selectedTag: null,
      filtering: false,
      deleteArmedId: null
    };
    return state;
  };

  expect(render(build(true), 120).replace(STRIP, "")).toBe(render(build(false), 120));
  expect(render(build(true), 140).replace(STRIP, "")).toBe(render(build(false), 140));
});

test("the composer caret lands on the same column when the draft holds zero-width format characters", () => {
  const draft = "the keeper wa\u200Blks the cliff ro\u2060ad after dark";
  const build = (text: string) => {
    const state = initialState(demoAppSource(), true);
    state.mode = "COMPOSE";
    state.composer = createComposer(text);
    return state;
  };

  const frame = render(build(draft), 120);
  const controlFrame = render(build(draft.replace(STRIP, "")), 120);
  expect(frame.replace(STRIP, "")).toBe(controlFrame);
});

test("emoji joiner clusters and combining marks keep their cells beside zero-width characters", () => {
  const state = initialState(demoAppSource(), true);
  for (const part of state.payload.path) {
    part.text = "she waved \u200B\u{1F469}\u200D\u{1F469}\u200D\u{1F467} at the café door on the cliff road";
  }

  const frame = render(state, 80);

  expect(frame).toContain("\u{1F469}\u200D\u{1F469}\u200D\u{1F467}");
  expect(frame).toContain("café");
});
