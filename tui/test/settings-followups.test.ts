import { describe, expect, test } from "bun:test";
import { initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { openFactEditor } from "../src/editor-action.js";
import { initialSettingsOverlay } from "../src/settings-overlay-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine } from "../src/screens/story/frame.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

function screen(state: ReturnType<typeof initialState>, width = 120, height = 30): string {
  return frameText(renderStoryScreen(state, {
    width, height, wrapCache: createWrapCache<ProseStyle>()
  }).lines);
}

describe("a focused row says so on every surface", () => {
  test("the fact editor marks the row the keyboard is on", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.stream = null;
    openFactEditor(state, state.payload.facts[0]!);
    const editor = state.editor;
    if (editor?.kind !== "fact") throw new Error("the fact editor did not open");
    editor.focus = "activation";

    const rows = screen(state, 100, 16).split("\n");
    const activation = rows.find((line) => line.includes("activation"))!;
    const tag = rows.find((line) => line.includes("tag "))!;
    // The choice rows had no focused state at all, so the row the keyboard
    // owned looked exactly like the ones it did not.
    expect(activation).toContain("▸ activation");
    expect(tag).not.toContain("▸");
  });

  test("the selected request message inverts instead of tinting its ink", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "REQUEST";
    state.request = { cursor: 0, scrollTop: 0, returnMode: "NAV" };
    const frame = renderStoryScreen(state, { width: 100, height: 20 });
    const header = frame.lines.find((line) => plainLine(line).includes(" 01 SYSTEM"))!;
    const block = header.find((part) => part.text.includes("01 SYSTEM"))!;

    // Prose ink on the accent is light on light in every warm theme; a block
    // inverts, the way the mode cells do.
    expect(block.background).toBe("focus / accent");
    expect(block.role).toBe("background");
  });
});

describe("the settings surface reads as a grid", () => {
  test("a shared disabled reason is stated once, not on every row", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    state.mode = "SETTINGS";
    state.settings = initialSettingsOverlay(source.settingsView, state.config);
    state.settings.sampling = {
      panel: "sampling", cursor: 0, logitBiasOrder: [], edit: null, result: null
    };
    const rendered = screen(state, 120, 30);
    const reason = "Dry run does not send provider requests.";

    // One reason held by every knob is a fact about the provider, not about
    // any row; repeated down the column it was the loudest thing on screen.
    expect(rendered).toContain(reason);
    expect(rendered.split(reason).length - 1).toBe(1);
  });
});
