import { describe, expect, test } from "bun:test";
import { dispatch, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";
import type { OrdinaryNodeStub, StoryNode, StoryPayload } from "../../shared/types.js";

function makeFixture(part1Instruction: string, part1ProseLines = 15) {
  const source = demoAppSource();
  const tallText = Array.from({ length: part1ProseLines }, (_, i) => `Prose line ${i + 1} of story part.`).join("\n\n");
  const node1: StoryNode = {
    id: "p1",
    parentId: null,
    text: tallText,
    instruction: part1Instruction,
    createdAt: "2026-07-22T00:00:00.000Z",
    model: "qwen3-32b",
    activeChildId: "p2"
  };
  const stub1: OrdinaryNodeStub = {
    id: "p1",
    parentId: null,
    preview: "Prose line 1...",
    words: 100,
    tokens: 120,
    childCount: 1,
    leafCount: 1,
    lastTouched: "2026-07-22T00:00:00.000Z",
    hasInstruction: true,
    activeChildId: "p2",
    instruction: part1Instruction
  };
  const p2Text = Array.from({ length: 5 }, (_, i) => `Second part prose line ${i + 1}.`).join("\n\n");
  const node2: StoryNode = {
    id: "p2",
    parentId: "p1",
    text: p2Text,
    instruction: "prompt for part two",
    createdAt: "2026-07-22T00:01:00.000Z",
    model: "qwen3-32b",
    activeChildId: null
  };
  const stub2: OrdinaryNodeStub = {
    id: "p2",
    parentId: "p1",
    preview: "Second part prose...",
    words: 50,
    tokens: 60,
    childCount: 0,
    leafCount: 1,
    lastTouched: "2026-07-22T00:01:00.000Z",
    hasInstruction: true,
    activeChildId: null,
    instruction: "prompt for part two"
  };
  const payload: StoryPayload = {
    ...source.payload,
    nodes: [stub1, stub2],
    path: [node1, node2],
    chapterBreaks: []
  };

  const state = {
    ...initialState(source, false),
    payload,
    focusIndex: 0,
    showInstructions: true,
    viewScroll: 4
  };
  return { source, state };
}

describe("sticky prompt", () => {
  test("the prompt pins to the top row once the part scrolls past it", () => {
    const { state } = makeFixture("make his money feel wrong");
    const frame = renderStoryScreen(state, { width: 120, height: 10, wrapCache: createWrapCache() });
    const topLine = plainLine(frame.lines[0]!);
    expect(topLine).toContain("» make his money feel wrong");
  });

  test("it is absent while p has prompts hidden", async () => {
    const { source, state } = makeFixture("make his money feel wrong");
    await dispatch({ action: "toggle-instructions" }, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.showInstructions).toBeFalse();

    const frame = renderStoryScreen(state, { width: 120, height: 10, wrapCache: createWrapCache() });
    const topLine = plainLine(frame.lines[0]!);
    expect(topLine).not.toContain("make his money feel wrong");
  });

  test("an expanded (multi-line) prompt does not pin", () => {
    const { state } = makeFixture("make his money feel wrong\nsecond line of instruction");
    state.expandedPromptIds.add("p1");

    const frame = renderStoryScreen(state, { width: 120, height: 10, wrapCache: createWrapCache() });
    const topLine = plainLine(frame.lines[0]!);
    expect(topLine).not.toContain("make his money feel wrong");
  });

  test("it stops pinning when the next part takes the top row", () => {
    const { state } = makeFixture("prompt for part one", 1);
    state.viewScroll = 5;

    const frame = renderStoryScreen(state, { width: 120, height: 5, wrapCache: createWrapCache() });
    const topLine = plainLine(frame.lines[0]!);
    expect(topLine).not.toContain("prompt for part one");
  });
});
