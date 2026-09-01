import { describe, expect, test } from "bun:test";
import { dispatch } from "../src/app.js";
import { createComposer, setComposerText } from "../src/composer-model.js";
import {
  FACTS_BUDGET_STATUS,
  isFactsBudgetEditor
} from "../src/facts-budget-editor.js";
import { openFactsBudgetEditor } from "../src/editor-open.js";
import { frameText, plainLine, visibleWidth } from "../src/screens/story/frame.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { pasteInto } from "../src/keys.js";
import { mouseToAction } from "../src/mouse-actions.js";
import type { RuntimeState } from "../src/state.js";
import { createWrapCache } from "../src/wrap.js";
import { editorHarness, key } from "./editor-harness.js";

function budgetEditor(state: RuntimeState) {
  if (!isFactsBudgetEditor(state.editor)) throw new Error("Facts Budget editor did not open");
  return state.editor;
}

async function openBudget(
  state: RuntimeState,
  press: (event: ReturnType<typeof key>) => Promise<void>
): Promise<void> {
  await press(key("p", { ctrl: true }));
  expect(state.mode).toBe("COMMANDS");
  state.commands = {
    query: "facts budget",
    cursor: 0,
    selectedId: "facts-budget",
    view: "commands",
    returnMode: state.commands?.returnMode ?? "NAV"
  };
  await press(key("return"));
  expect(state.mode).toBe("EDITOR");
  expect(isFactsBudgetEditor(state.editor)).toBeTrue();
}

function render(state: RuntimeState, width = 100, height = 24) {
  const frame = renderStoryScreen(state, {
    width,
    height,
    wrapCache: createWrapCache()
  });
  Object.assign(state, frame.derived);
  return frame;
}

function clickToken(
  state: RuntimeState,
  frame: ReturnType<typeof render>,
  token: string
) {
  const row = frame.lines.findIndex((line) => plainLine(line).includes(token));
  expect(row).toBeGreaterThan(-1);
  const line = plainLine(frame.lines[row]!);
  const start = line.indexOf(token);
  return mouseToAction({
    type: "down",
    button: 0,
    x: visibleWidth(line.slice(0, start)) + Math.floor(visibleWidth(token) / 2),
    y: row,
    modifiers: { shift: false, alt: false, ctrl: false }
  } as never, state);
}

describe("story Facts Budget editor", () => {
  test("renders a compact bounded field and admits digits only", async () => {
    const { state, press } = editorHarness();
    await openBudget(state, press);

    const frame = render(state);
    const drawn = frameText(frame.lines);
    expect(drawn).toContain("facts budget [");
    expect(drawn).toContain(FACTS_BUDGET_STATUS);
    expect(drawn).toContain("uncapped");
    expect(drawn).not.toContain("Cap the combined estimated tokens");
    expect(frame.lines.length).toBe(24);

    const editor = budgetEditor(state);
    await press(key("x"));
    expect(editor.composer.text).toBe("");
    expect(state.toast).toBe("facts budget accepts digits only");
    await press(key("7"));
    expect(editor.composer.text).toBe("7");
    expect(pasteInto(state, "8x")).toBeTrue();
    expect(editor.composer.text).toBe("7");
    expect(pasteInto(state, "8")).toBeTrue();
    expect(editor.composer.text).toBe("78");

    setComposerText(editor.composer, "1000001");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("EDITOR");
    expect(state.payload.factsBudgetTokens).toBe(undefined);
    expect(state.toast).toBe("facts budget must be between 1 and 1,000,000");
  });

  test("Enter and Ctrl+S save the number, while Escape cancels and empty clears", async () => {
    const { state, press } = editorHarness();
    await openBudget(state, press);
    const editor = budgetEditor(state);
    await press(key("4"));
    await press(key("2"));
    await press(key("return", { sequence: "\r" }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.factsBudgetTokens).toBe(42);

    await openBudget(state, press);
    await press(key("9"));
    expect(budgetEditor(state).composer.text).toBe("9");
    setComposerText(budgetEditor(state).composer, "");
    await press(key("s", { sequence: "\u0013", ctrl: true }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.factsBudgetTokens).toBe(undefined);

    await openBudget(state, press);
    setComposerText(budgetEditor(state).composer, "19");
    await press(key("escape", { sequence: "\u001b" }));
    expect(state.mode).toBe("NAV");
    expect(state.payload.factsBudgetTokens).toBe(undefined);
  });

  test("the field, clear control, and save control respond to mouse input", async () => {
    const { source, state, press } = editorHarness();
    await openBudget(state, press);
    setComposerText(budgetEditor(state).composer, "314");
    let frame = render(state);

    const fieldRow = state.hitRows.findIndex((row) => row?.target.kind === "composer");
    expect(fieldRow).toBeGreaterThan(-1);
    expect(mouseToAction({
      type: "down",
      button: 0,
      x: 30,
      y: fieldRow,
      modifiers: { shift: false, alt: false, ctrl: false }
    } as never, state)).toEqual({ action: "compose" });

    const clear = clickToken(state, frame, "clear");
    expect(clear).toEqual({ action: "delete-line" });
    await dispatch(clear!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(budgetEditor(state).composer.text).toBe("");

    setComposerText(budgetEditor(state).composer, "314");
    frame = render(state);
    const save = clickToken(state, frame, "ctrl+s save");
    expect(save).toEqual({ action: "save-edit" });
    await dispatch(save!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.mode).toBe("NAV");
    expect(state.payload.factsBudgetTokens).toBe(314);
  });

  test("clicking between budget digits places the insertion caret", async () => {
    const { source, state, press } = editorHarness();
    state.payload = { ...state.payload, factsBudgetTokens: 314 };
    await openBudget(state, press);
    const editor = budgetEditor(state);
    expect(editor.composer.anchor).toBe(0);

    const frame = render(state);
    const row = frame.lines.findIndex((line) => plainLine(line).includes("314"));
    expect(row).toBeGreaterThan(-1);
    const line = plainLine(frame.lines[row]!);
    const digits = line.indexOf("314");
    const action = mouseToAction({
      type: "down",
      button: 0,
      // The second digit cell represents the boundary before that digit.
      x: visibleWidth(line.slice(0, digits + 1)),
      y: row,
      modifiers: { shift: false, alt: false, ctrl: false }
    } as never, state);
    expect(action).toEqual({ action: "compose", composerCursor: 1 });

    await dispatch(action!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(editor.composer.cursor).toBe(1);
    expect(editor.composer.anchor).toBe(null);
    await press(key("9"));
    expect(editor.composer.text).toBe("3914");
  });

  test("clicking after the final budget digit appends after the open selection", async () => {
    const { source, state, press } = editorHarness();
    state.payload = { ...state.payload, factsBudgetTokens: 314 };
    await openBudget(state, press);
    const editor = budgetEditor(state);
    const frame = render(state);
    const row = frame.lines.findIndex((line) => plainLine(line).includes("314"));
    expect(row).toBeGreaterThan(-1);
    const line = plainLine(frame.lines[row]!);
    const digits = line.indexOf("314");
    const action = mouseToAction({
      type: "down",
      button: 0,
      x: visibleWidth(line.slice(0, digits + 3)),
      y: row,
      modifiers: { shift: false, alt: false, ctrl: false }
    } as never, state);
    expect(action).toEqual({ action: "compose", composerCursor: 3 });

    await dispatch(action!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(editor.composer.cursor).toBe(3);
    expect(editor.composer.anchor).toBe(null);
    await press(key("9"));
    expect(editor.composer.text).toBe("3149");
  });

  test("does not replace a suspended Fact draft when the global palette selects Facts Budget", async () => {
    const { state, press } = editorHarness();
    await press(key("f"));
    await press(key("return"));
    if (state.editor?.kind !== "fact") throw new Error("Fact editor did not open");
    const factEditor = state.editor;
    const draft = `${factEditor.composer.text} unsaved`;
    setComposerText(factEditor.composer, draft);

    openFactsBudgetEditor(state);
    expect(state.mode).toBe("EDITOR");
    expect(state.editor).toBe(factEditor);
    expect(state.editor?.kind === "fact" ? state.editor.composer.text : null).toBe(draft);
    expect(state.toast).toBe("save or cancel this Fact before opening facts budget");
  });
});
