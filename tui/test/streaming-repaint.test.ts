import { describe, expect, test } from "bun:test";
import { continuationStats, createStoryIndex } from "../../shared/story-model.js";
import type { StoryNode, StoryPayload } from "../../shared/types.js";
import { initialState } from "../src/app.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import type { MapState, MapView } from "../src/map-state.js";
import { renderMapScreen } from "../src/screens/map.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText, plainLine } from "../src/screens/story/frame.js";
import type { RuntimeState, StreamView } from "../src/state.js";
import { projectStreamedPayload } from "../src/stream-projection.js";
import { appendStreamText, emptyStreamText } from "../src/stream-text.js";
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
