import { describe, expect, test } from "bun:test";
import type { StoryPayload } from "../../shared/types.js";
import { initialState } from "../src/app.js";
import { createDemoController, demoAppSource } from "../src/demo.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { plainLine } from "../src/screens/story/frame.js";
import type { RuntimeState, StreamView } from "../src/state.js";
import { appendStreamText, emptyStreamText } from "../src/stream-text.js";
import { createWrapCache, type ProseStyle } from "../src/wrap.js";

const STARTED_AT = "2026-07-22T00:00:00.000Z";
const NOW = 1_667_000_000_000;

// Deltas cross word, whitespace, and paragraph boundaries, and one word is
// split across two batches, so incremental word counting has to carry state.
const DELTAS = [
  "   ",
  " The lantern cou",
  "nted the storm's windows",
  "\n\nNobody said the traveler's name aloud,",
  " twice.  "
];

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

function frameFor(state: RuntimeState, cache = createWrapCache<ProseStyle>()): string {
  return renderStoryScreen(state, { width: 120, height: 36, wrapCache: cache })
    .lines.map(plainLine).join("\n");
}

/** Cold reference: a structurally fresh payload and stream deny every memo,
 * so the frame is what a from-scratch projection renders. */
function coldFrame(payload: StoryPayload, stream: StreamView, text: string): string {
  const freshStream: StreamView = { ...stream, ...emptyStreamText() };
  appendStreamText(freshStream, text);
  return frameFor(streamedState(structuredClone(payload), freshStream));
}

describe("streaming repaint", () => {
  test("append frames match a cold projection at every delta batch", () => {
    const payload = createDemoController().payload();
    const target = payload.path.at(-1)!;
    const stream: StreamView = {
      targetId: target.id,
      parentId: target.parentId,
      append: true,
      startedAt: STARTED_AT,
      instruction: "",
      ...emptyStreamText()
    };
    const live = streamedState(payload, stream);
    const cache = createWrapCache<ProseStyle>();
    let streamed = "";
    for (const delta of DELTAS) {
      appendStreamText(stream, delta);
      streamed += delta;
      expect(frameFor(live, cache)).toBe(coldFrame(payload, stream, streamed));
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
    for (const delta of DELTAS) {
      appendStreamText(stream, delta);
      streamed += delta;
      expect(frameFor(live, cache)).toBe(coldFrame(payload, stream, streamed));
    }
  });
});
