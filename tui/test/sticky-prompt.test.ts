import { describe, expect, test } from "bun:test";
import { INERT_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
import { dispatch, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import { createWrapCache } from "../src/wrap.js";
import { createReasoningRecord } from "../../shared/reasoning.js";
import type { RuntimeState } from "../src/state.js";
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

  const state: RuntimeState = {
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
    await dispatch(
      { action: "toggle-instructions" }, state, source, createWrapCache(),
      () => {}, async () => {}, () => {},
      { updateChecks: INERT_UPDATE_CHECK_LIFECYCLE }
    );
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

  test("an unfolded thought block measures its own dynamic prefix height", () => {
    // A compact (unexpanded) prompt is normally one fixed prefix row —
    // `prefixHeight`'s static formula. An unfolded thought block is the
    // second thing that can make a prefix taller than that formula knows,
    // and it must do so even when the prompt itself stays compact.
    const { state } = makeFixture("prompt for part one", 1);
    // This test is about prefix height, not sticky scrolling — read from the
    // natural top instead of inheriting the fixture's pinned-scroll setup.
    state.viewScroll = null;
    state.payload = {
      ...state.payload,
      path: state.payload.path.map((node) => node.id === "p1" ? { ...node, reasoning: true } : node),
      nodes: state.payload.nodes.map((stub) => stub.id === "p1" ? { ...stub, reasoning: true } : stub)
    };
    state.reasoning = "marker";
    state.expandedThoughtIds.add("p1");
    state.thoughts.set("p1", {
      status: "ready",
      record: createReasoningRecord({
        text: "First he checked the weather, then the tide charts, then his own nerve.",
        tokenCount: 200
      })
    });

    const frame = renderStoryScreen(state, { width: 120, height: 20, wrapCache: createWrapCache() });
    const text = frame.lines.map(plainLine).join("\n");
    const promptLine = text.indexOf("» prompt for part one");
    const thoughtLine = text.indexOf("checked the weather");
    const secondPartLine = text.indexOf("Second part prose line 1.");
    expect(promptLine).toBeGreaterThan(-1);
    expect(thoughtLine).toBeGreaterThan(-1);
    expect(secondPartLine).toBeGreaterThan(-1);
    // Reading order: the instruction first, the thought above the prose it
    // led to, then the prose itself — never overlapped or reordered by the
    // dynamic height measurement.
    expect(promptLine).toBeLessThan(thoughtLine);
    expect(thoughtLine).toBeLessThan(secondPartLine);
  });

  test("it stops pinning when the next part takes the top row", () => {
    const { state } = makeFixture("prompt for part one", 1);
    state.viewScroll = 5;

    const frame = renderStoryScreen(state, { width: 120, height: 5, wrapCache: createWrapCache() });
    const topLine = plainLine(frame.lines[0]!);
    expect(topLine).not.toContain("prompt for part one");
  });
});
