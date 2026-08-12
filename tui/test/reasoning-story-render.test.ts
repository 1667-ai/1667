import { describe, expect, test } from "bun:test";
import { createReasoningRecord } from "../../shared/reasoning.js";
import type { OrdinaryNodeStub, StoryNode, StoryPayload } from "../../shared/types.js";
import { dispatch, initialState } from "../src/app.js";
import { demoAppSource } from "../src/demo.js";
import { mouseToAction } from "../src/mouse-actions.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import type { RuntimeState } from "../src/state.js";
import { appendStreamReasoning, appendStreamText, emptyStreamText } from "../src/stream-text.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const NOW = 1_667_000_000_000;

/** Three parts on the active line: an unremarkable root (p1); p2, which has
 *  both a sibling (so its own unfocused waymark contends between `×2` and a
 *  thought) and a stored thought; and the leaf p3, focused by default, also
 *  with a stored thought. Neither part's prose ever says the word "thought"
 *  or "thinking", so a bare `toContain` check for either can only be seeing
 *  the feature's own copy. */
function makeFixture(): { source: ReturnType<typeof demoAppSource>; state: RuntimeState } {
  const source = demoAppSource();
  const node1: StoryNode = {
    id: "p1", parentId: null, text: "The road climbed past the last farmhouse.",
    instruction: "", createdAt: "2026-07-22T00:00:00.000Z", model: "qwen3-32b",
    activeChildId: "p2"
  };
  const stub1: OrdinaryNodeStub = {
    id: "p1", parentId: null, preview: "The road climbed...", words: 30, tokens: 40,
    childCount: 1, leafCount: 1, lastTouched: "2026-07-22T00:00:00.000Z",
    hasInstruction: false, activeChildId: "p2"
  };
  const node2: StoryNode = {
    id: "p2", parentId: "p1", text: "She found the gate standing open.",
    instruction: "she arrives", createdAt: "2026-07-22T00:01:00.000Z", model: "qwen3-32b",
    activeChildId: "p3", reasoning: true
  };
  const stub2: OrdinaryNodeStub = {
    id: "p2", parentId: "p1", preview: "She found the gate...", words: 20, tokens: 30,
    childCount: 1, leafCount: 1, lastTouched: "2026-07-22T00:01:00.000Z",
    hasInstruction: true, activeChildId: "p3", reasoning: true, instruction: "she arrives"
  };
  const node2b: StoryNode = {
    id: "p2b", parentId: "p1", text: "She turned back at the gate.",
    instruction: "she hesitates", createdAt: "2026-07-22T00:01:30.000Z", model: "qwen3-32b",
    activeChildId: null
  };
  const stub2b: OrdinaryNodeStub = {
    id: "p2b", parentId: "p1", preview: "She turned back...", words: 15, tokens: 20,
    childCount: 0, leafCount: 1, lastTouched: "2026-07-22T00:01:30.000Z",
    hasInstruction: true, activeChildId: null, instruction: "she hesitates"
  };
  const node3: StoryNode = {
    id: "p3", parentId: "p2", text: "Inside, the lanterns were still burning.",
    instruction: "", createdAt: "2026-07-22T00:02:00.000Z", model: "qwen3-32b",
    activeChildId: null, reasoning: true
  };
  const stub3: OrdinaryNodeStub = {
    id: "p3", parentId: "p2", preview: "Inside, the lanterns...", words: 25, tokens: 35,
    childCount: 0, leafCount: 1, lastTouched: "2026-07-22T00:02:00.000Z",
    hasInstruction: false, activeChildId: null, reasoning: true
  };
  const payload: StoryPayload = {
    ...source.payload,
    nodes: [stub1, stub2, stub2b, stub3],
    path: [node1, node2, node3],
    chapterBreaks: []
  };
  const state: RuntimeState = {
    ...initialState(source, false),
    payload,
    focusIndex: 2,
    showInstructions: false,
    now: NOW
  };
  return { source, state };
}

function render(state: RuntimeState, width = 120, height = 30) {
  const rendered = renderStoryScreen(state, { width, height, wrapCache: createWrapCache<ProseStyle>() });
  Object.assign(state, rendered.derived);
  return rendered.lines;
}

function frame(state: RuntimeState, width = 120, height = 30): string {
  return render(state, width, height).map(plainLine).join("\n");
}

const click = (x: number, y: number) => ({
  type: "down", button: 0, x, y, modifiers: { shift: false, alt: false, ctrl: false }
}) as never;

describe("thought waymark", () => {
  test("marker mode: unfocused ghost, ×n wins the collision, focused folded row", () => {
    const { state } = makeFixture();
    state.reasoning = "marker";
    const text = frame(state);
    const lines = text.split("\n");

    // p2 (unfocused, siblingCount 2, has a thought): the fork tick wins the
    // one unfocused gutter cell — see the comment in gutterFor's final
    // unconditional block for why. Column matches golden.test.ts's own ×2
    // assertion (right-aligned gutter, width 24).
    const gateLine = lines.find((line) => line.includes("gate standing open"));
    expect(gateLine?.indexOf("×2")).toBe(21);
    expect(gateLine).not.toContain("thought");

    // p3 (focused, siblingCount 1, has a thought, folded): the extra gutter
    // row, and the verb menu still intact below it (proves gutterRows grew
    // to fit it rather than clipping the menu).
    expect(text).toContain("thought · T shows");
    expect(text).toContain("␠ continue");
    expect(text).toContain("w write");
    expect(text).not.toContain("┊");
  });

  test("marker mode: unfocused ghost word when there is no fork tick to contend with", () => {
    const { state } = makeFixture();
    state.reasoning = "marker";
    state.focusIndex = 0; // p1, which has no thought — p3 renders unfocused.
    const lines = frame(state).split("\n");
    const leafLine = lines.find((line) => line.includes("lanterns were still burning"));
    expect(leafLine?.indexOf("thought")).toBe(16);
  });

  test("T says why it did nothing instead of reading as a dead key", async () => {
    const cache = createWrapCache<ProseStyle>();

    // The keys list offers T on every take, so pressing it on one without a
    // thought is ordinary. p1 has none.
    const noThought = makeFixture();
    noThought.state.reasoning = "marker";
    noThought.state.focusIndex = 0;
    await dispatch(
      { action: "toggle-thought" }, noThought.state, noThought.source,
      cache, () => {}, async () => {}, () => {}
    );
    expect(noThought.state.toast).toBe("no thought on this take");
    expect(noThought.state.expandedThoughtIds.size).toBe(0);

    // `off` renders no thought at all, so the fold this would flip is
    // invisible. Saying so beats mutating state nothing draws.
    const off = makeFixture();
    off.state.reasoning = "off";
    off.state.thoughts.set("p3", {
      status: "ready",
      record: createReasoningRecord({ text: "Three ways down.", tokenCount: 1_400 })
    });
    await dispatch(
      { action: "toggle-thought" }, off.state, off.source,
      cache, () => {}, async () => {}, () => {}
    );
    expect(off.state.toast).toBe("thoughts are off · settings turns them on");
    expect(off.state.expandedThoughtIds.size).toBe(0);
  });

  test("T unfolds the focused part's thought, and folds it back", async () => {
    const { source, state } = makeFixture();
    state.reasoning = "marker";
    const cache = createWrapCache<ProseStyle>();
    state.thoughts.set("p3", {
      status: "ready",
      record: createReasoningRecord({ text: "Three ways down: rope, stair, jump.", tokenCount: 1_400 })
    });

    await dispatch({ action: "toggle-thought" }, state, source, cache, () => {}, async () => {}, () => {});
    expect(state.expandedThoughtIds.has("p3")).toBeTrue();

    const unfolded = frame(state);
    expect(unfolded).toContain("thought · 1.4k");
    expect(unfolded).toContain("T folds");
    expect(unfolded).toContain("┊");
    expect(unfolded).toContain("Three ways down: rope, stair, jump.");
    expect(unfolded).not.toContain("thought · T shows");

    await dispatch({ action: "toggle-thought" }, state, source, cache, () => {}, async () => {}, () => {});
    expect(state.expandedThoughtIds.has("p3")).toBeFalse();
    const folded = frame(state);
    expect(folded).toContain("thought · T shows");
    expect(folded).not.toContain("Three ways down");
  });

  test("clicking the waymark toggles fold state, the same as pressing T", async () => {
    const { source, state } = makeFixture();
    state.reasoning = "marker";
    state.thoughts.set("p3", {
      status: "ready",
      record: createReasoningRecord({ text: "Three ways down: rope, stair, jump.", tokenCount: 1_400 })
    });

    render(state);
    const thoughtHit = state.hitRows
      .flatMap((row, y) => (row?.overrides ?? []).map((hit) => ({ hit, y })))
      .find(({ hit }) => hit.target.kind === "thought" && hit.target.rowId === "p3");
    expect(thoughtHit).toBeDefined();

    const resolved = mouseToAction(click(thoughtHit!.hit.left, thoughtHit!.y), state);
    expect(resolved).toEqual({ action: "toggle-thought", index: 2, rowId: "p3" });

    await dispatch(resolved!, state, source, createWrapCache(), () => {}, async () => {}, () => {});
    expect(state.expandedThoughtIds.has("p3")).toBeTrue();
    expect(frame(state)).toContain("Three ways down: rope, stair, jump.");
  });

  test("open mode arrives unfolded, for an unfocused part too", () => {
    const { state } = makeFixture();
    state.reasoning = "open";
    state.thoughts.set("p2", {
      status: "ready",
      record: createReasoningRecord({ text: "She hesitated at the threshold.", tokenCount: 300 })
    });
    const text = frame(state);
    // p2 is not focused, but `open` unfolds every thought by default.
    expect(text).toContain("She hesitated at the threshold.");
    expect(text).toContain("T folds");
    // No `T` was ever pressed, so nothing is in the explicit-toggle set —
    // the mode alone accounts for the unfolded state.
    expect(state.expandedThoughtIds.size).toBe(0);
  });

  test("off renders nothing: no waymark, no block, no keyline entry, no streaming line", () => {
    const { state } = makeFixture();
    state.reasoning = "off";
    state.expandedThoughtIds.add("p3");
    state.thoughts.set("p3", {
      status: "ready",
      record: createReasoningRecord({ text: "Three ways down: rope, stair, jump.", tokenCount: 1_400 })
    });
    const text = frame(state);
    expect(text).not.toContain("thought");
    expect(text).not.toContain("thinking");
    expect(text).not.toContain("┊");
    expect(text).not.toContain("Three ways down");
  });

  test("the keyline shows T thought only when the focused part has a thought", () => {
    const { state } = makeFixture();
    state.reasoning = "marker";
    expect(frame(state)).toContain("T thought");

    // Focus p1, which has no thought at all.
    state.focusIndex = 0;
    expect(frame(state)).not.toContain("T thought");
  });

  test("80 columns drops the gutter waymark; T thought stays the only affordance", () => {
    const { state } = makeFixture();
    state.reasoning = "marker";
    const wide = frame(state, 120);
    const narrow = frame(state, 80);
    expect(wide).toContain("thought · T shows");
    // Narrow mode drops every side-gutter cell (`prefixLine`), thought marks
    // included — never abbreviated, just absent. `T thought` in the keyline
    // is what is left to discover the feature by.
    expect(narrow).not.toContain("thought · T shows");
    expect(narrow.split("\n").some((line) => line.trim() === "thought")).toBeFalse();
    expect(narrow).toContain("T thought");
  });
});

describe("streaming thought line", () => {
  function streamingState(reasoningText: string, tokenCount: number): RuntimeState {
    const { state } = makeFixture();
    state.reasoning = "marker";
    state.stream = {
      targetId: "streamed-take",
      parentId: "p3",
      append: false,
      startedAt: "2026-07-22T00:03:00.000Z",
      instruction: "",
      ...emptyStreamText()
    };
    appendStreamReasoning(state.stream, reasoningText, tokenCount);
    state.focusIndex = 3;
    return state;
  }

  test("reasoning arrives before prose: thinking line, dim caret, no writing/spinner text", () => {
    const state = streamingState("Weighing three routes down.", 618);
    const text = frame(state);
    expect(text).toContain("⟳ thinking · 618 tok");
    expect(text).toContain("esc stops · T peeks");
    expect(text).not.toContain("writing");
    expect(text).not.toContain("⠋");
  });

  test("an unknown token count never fabricates a number", () => {
    const state = streamingState("Weighing three routes down.", 0);
    const text = frame(state);
    expect(text).toContain("⟳ thinking");
    expect(text).not.toContain("⟳ thinking ·");
  });

  test("prose starts: the gutter reverts to the ordinary writing line", () => {
    const state = streamingState("Weighing three routes down.", 618);
    appendStreamText(state.stream!, "Three ways down");
    const text = frame(state);
    expect(text).not.toContain("⟳ thinking");
    expect(text).toContain("writing");
  });

  test("off suppresses the streaming line too", () => {
    const state = streamingState("Weighing three routes down.", 618);
    state.reasoning = "off";
    const text = frame(state);
    expect(text).not.toContain("thinking");
    expect(text).not.toContain("T peeks");
    expect(text).toContain("writing");
  });
});
