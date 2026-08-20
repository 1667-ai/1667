import { describe, expect, test } from "bun:test";
import { continuationStats, createStoryIndex } from "../../shared/story-model.js";
import { countWords } from "../../shared/story-text.js";
import type { StoryNode, StoryPayload } from "../../shared/types.js";
import { initialState } from "../src/app.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import type { MapState, MapView } from "../src/map-state.js";
import { renderMapScreen } from "../src/screens/map.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine } from "../src/screens/story/frame.js";
import type { RuntimeState, StreamView } from "../src/state.js";
import { projectStreamedPayload } from "../src/stream-projection.js";
import { appendStreamReasoning, appendStreamText, emptyStreamText } from "../src/stream-text.js";
import { createTextPresentation } from "../src/text-presentation.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const STARTED_AT = "2026-07-22T00:00:00.000Z";
const NOW = 1_667_000_000_000;

// The first append batch starts with a word character so the settled→streamed
// seam joins words, one word is split across two batches, and later batches
// cross whitespace and paragraph boundaries.
const APPEND_DELTAS = [
  "and then the lantern cou",
  "nted the storm's windows",
  "\n\nNobody said the traveler's name aloud,",
  " twice.  ",
  "   "
];

// A new take first claims its row with whitespace-only bytes (pending shape),
// then streams substantive text behind server trim semantics.
const TAKE_DELTAS = [
  "   ",
  " The lantern cou",
  "nted the windows",
  "\n\nNobody spoke,",
  " twice.  "
];

function appendStream(target: StoryNode): StreamView {
  return {
    targetId: target.id,
    parentId: target.parentId,
    append: true,
    startedAt: STARTED_AT,
    instruction: "",
    ...emptyStreamText()
  };
}

function streamedState(payload: StoryPayload, stream: StreamView | null): RuntimeState {
  const state: RuntimeState = {
    ...initialState(demoAppSource(), false),
    payload,
    stream,
    now: NOW,
    freshLandedAt: new Map()
  };
  state.focusIndex = payload.path.length - 1;
  return state;
}

/** A structurally fresh payload and stream deny every memo, so this state
 * renders what a from-scratch projection produces. */
function coldState(payload: StoryPayload, stream: StreamView, text: string): RuntimeState {
  const freshStream: StreamView = { ...stream, ...emptyStreamText() };
  appendStreamText(freshStream, text);
  return streamedState(structuredClone(payload), freshStream);
}

// Whitespace-only leading bytes first, like TAKE_DELTAS, then substantive
// text — the unfolded block must not paint before there is anything to
// paint, and the warm and cold paths must agree at every one of these steps.
const REASONING_DELTAS = [
  "  ",
  "Three ways down: rope, the",
  " old stair, jumping.",
  " The stair collapsed",
  " in ¶9, canon."
];

function storyFrame(state: RuntimeState, cache = createWrapCache<ProseStyle>()): string {
  return renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache })
    .lines.map(plainLine).join("\n");
}

function mapFrame(state: RuntimeState, view: MapView): string {
  const leaf = state.payload.path.at(-1)!.id;
  const map: MapState = {
    view,
    pathCursorId: leaf,
    pathShowAllTakes: true,
    treeCursorId: leaf,
    rowIds: [],
    showSketches: false,
    openedColdFolds: new Set(),
    massSort: "size"
  };
  return frameText(renderMapScreen(state, map, 120, 36, []).lines);
}

describe("streaming repaint", () => {
  test("append frames match a cold projection at every delta batch", () => {
    const payload = createDemoController().payload();
    const stream = appendStream(payload.path.at(-1)!);
    const live = streamedState(payload, stream);
    const cache = createWrapCache<ProseStyle>();
    let streamed = "";
    for (const delta of APPEND_DELTAS) {
      appendStreamText(stream, delta);
      streamed += delta;
      expect(storyFrame(live, cache)).toBe(storyFrame(coldState(payload, stream, streamed)));
    }
  });

  test("new-take frames match a cold projection at every delta batch", () => {
    const payload = createDemoController().payload();
    const parent = payload.path.at(-1)!;
    const stream: StreamView = {
      targetId: "streamed-take",
      parentId: parent.id,
      append: false,
      startedAt: STARTED_AT,
      instruction: "keep the storm outside",
      ...emptyStreamText()
    };
    const live = streamedState(payload, stream);
    const cache = createWrapCache<ProseStyle>();
    let streamed = "";
    for (const delta of TAKE_DELTAS) {
      appendStreamText(stream, delta);
      streamed += delta;
      expect(storyFrame(live, cache)).toBe(storyFrame(coldState(payload, stream, streamed)));
    }
  });

  test("reasoning deltas match a cold projection at every batch, thought block included", () => {
    const payload = createDemoController().payload();
    const parent = payload.path.at(-1)!;
    const stream: StreamView = {
      targetId: "streamed-take",
      parentId: parent.id,
      append: false,
      startedAt: STARTED_AT,
      instruction: "keep the storm outside",
      ...emptyStreamText()
    };
    const live = streamedState(payload, stream);
    live.reasoning = "open";
    const cache = createWrapCache<ProseStyle>();
    let streamedReasoning = "";
    let tokenCount = 0;
    for (const delta of REASONING_DELTAS) {
      tokenCount += 1;
      appendStreamReasoning(stream, delta, tokenCount);
      streamedReasoning += delta;
      // A structurally fresh payload and stream deny every memo, the same
      // guarantee `coldState` gives the prose-only tests above — built by
      // hand here since the reasoning growth needs its own fresh stream.
      const coldStream: StreamView = { ...stream, ...emptyStreamText() };
      appendStreamReasoning(coldStream, streamedReasoning, tokenCount);
      const cold = streamedState(structuredClone(payload), coldStream);
      cold.reasoning = "open";
      expect(storyFrame(live, cache)).toBe(storyFrame(cold));
    }
  });

  test("MAP frames during streaming match a cold projection at every batch", () => {
    const payload = createDemoController().payload();
    const stream = appendStream(payload.path.at(-1)!);
    const live = streamedState(payload, stream);
    let streamed = "";
    for (const delta of APPEND_DELTAS) {
      appendStreamText(stream, delta);
      streamed += delta;
      for (const view of ["path", "tree", "mass"] as const) {
        expect(mapFrame(live, view)).toBe(mapFrame(coldState(payload, stream, streamed), view));
      }
    }
  });

  test("continuation word totals stay live while streaming", () => {
    const payload = createDemoController().payload();
    const stream = appendStream(payload.path.at(-1)!);
    let streamed = "";
    for (const delta of APPEND_DELTAS) {
      appendStreamText(stream, delta);
      streamed += delta;
      const live = projectStreamedPayload(payload, stream, { includePendingTake: true });
      const liveIndex = createStoryIndex(live);
      const coldStream: StreamView = { ...stream, ...emptyStreamText() };
      appendStreamText(coldStream, streamed);
      const cold = projectStreamedPayload(structuredClone(payload), coldStream, { includePendingTake: true });
      const coldIndex = createStoryIndex(cold);
      for (const node of cold.nodes) {
        expect(continuationStats(live, node.id, liveIndex))
          .toEqual(continuationStats(cold, node.id, coldIndex));
      }
    }
  });

  test("paced rewrite word totals match the visible spliced text", () => {
    const payload = createDemoController().payload();
    const target = payload.path.at(-1)!;
    const presentation = createTextPresentation();
    const stream: StreamView = {
      targetId: target.id,
      parentId: target.parentId,
      append: false,
      rewrite: { start: 7, end: 29 },
      startedAt: STARTED_AT,
      instruction: "replace the passage",
      ...emptyStreamText(),
      presentation
    };
    appendStreamText(stream, "joined replacement words ".repeat(20));

    for (;;) {
      const projected = projectStreamedPayload(payload, stream);
      const node = projected.path.find((candidate) => candidate.id === target.id)!;
      const stub = projected.nodes.find((candidate) => candidate.id === target.id)!;
      expect(stub.words).toBe(countWords(node.text));
      const cold = projectStreamedPayload(structuredClone(payload), stream);
      const coldNode = cold.path.find((candidate) => candidate.id === target.id)!;
      const coldStub = cold.nodes.find((candidate) => candidate.id === target.id)!;
      expect(coldStub.words).toBe(countWords(coldNode.text));
      if (stream.presentation?.pendingLength === 0) break;
      if (stream.presentation?.advance() !== true) break;
    }
    stream.presentation?.dispose();
  });

  test("paced append word totals survive a cold payload cache miss", () => {
    const payload = createDemoController().payload();
    const target = payload.path.at(-1)!;
    target.text = `${target.text.trimEnd()}joined`;
    const stream = appendStream(target);
    stream.presentation = createTextPresentation();
    appendStreamText(stream, " continuation words after the seam");

    const cold = projectStreamedPayload(structuredClone(payload), stream);
    const node = cold.path.find((candidate) => candidate.id === target.id)!;
    const stub = cold.nodes.find((candidate) => candidate.id === target.id)!;

    expect(stub.words).toBe(countWords(node.text));
    stream.presentation.dispose();
  });

  test("paced take word totals retain a cold trailing separator", () => {
    const payload = createDemoController().payload();
    const parent = payload.path.at(-1)!;
    const presentation = createTextPresentation();
    const stream: StreamView = {
      targetId: "streamed-take",
      parentId: parent.id,
      append: false,
      startedAt: STARTED_AT,
      instruction: "continue",
      ...emptyStreamText(),
      presentation
    };
    appendStreamText(stream, "one ");
    const coldPayload = structuredClone(payload);
    projectStreamedPayload(coldPayload, stream);

    appendStreamText(stream, "two");
    presentation.advance();
    const projected = projectStreamedPayload(coldPayload, stream);
    const node = projected.path.find((candidate) => candidate.id === stream.targetId)!;
    const stub = projected.nodes.find((candidate) => candidate.id === stream.targetId)!;

    expect(stub.words).toBe(2);
    expect(stub.words).toBe(countWords(node.text));
    presentation.dispose();
  });

  test("an incomplete streamed preview clears settled map text", () => {
    const payload = createDemoController().payload();
    const target = payload.path.at(-1)!;
    target.text = `${" ".repeat(600)}old`;
    const stub = payload.nodes.find((candidate) => candidate.id === target.id)!;
    stub.preview = "old";
    const stream: StreamView = {
      targetId: target.id,
      parentId: target.parentId,
      append: false,
      rewrite: { start: 600, end: 603 },
      startedAt: STARTED_AT,
      instruction: "replace",
      ...emptyStreamText()
    };
    appendStreamText(stream, "new");

    const projected = projectStreamedPayload(payload, stream);
    const projectedStub = projected.nodes.find((candidate) => candidate.id === target.id)!;

    expect(projectedStub.preview).toBe("");
  });

  test("adopting a payload mid-stream keeps frames equal to a cold projection", () => {
    const payload = createDemoController().payload();
    const stream = appendStream(payload.path.at(-1)!);
    const live = streamedState(payload, stream);
    const cache = createWrapCache<ProseStyle>();
    appendStreamText(stream, APPEND_DELTAS[0]!);
    storyFrame(live, cache);
    // Adoption replaces the payload object while the same stream keeps landing.
    live.payload = structuredClone(payload);
    appendStreamText(stream, APPEND_DELTAS[1]!);
    const streamed = APPEND_DELTAS[0]! + APPEND_DELTAS[1]!;
    expect(storyFrame(live, cache)).toBe(storyFrame(coldState(live.payload, stream, streamed)));
  });
});
