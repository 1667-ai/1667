import { describe, expect, test } from "bun:test";
import { STARTER_OPENING_STORY_ID } from "../../shared/starter-vault.js";
import { demoAppSource } from "../src/demo.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForNode } from "../src/model.js";
import {
  forgetReadingPosition,
  openingFocusIndex,
  rememberReadingPosition
} from "../src/reading-position.js";
import {
  flushReadingPositionPersist,
  rememberFocus
} from "../src/reading-position-persist.js";

describe("reading position", () => {
  test("tour without a store opens at the first part", () => {
    const payload = { ...demoAppSource().payload, id: STARTER_OPENING_STORY_ID };
    expect(openingFocusIndex(payload, null)).toBe(0);
  });

  test("other stories without a store open at the line end", () => {
    const payload = demoAppSource().payload;
    expect(openingFocusIndex(payload, null))
      .toBe(lastPartRowIndex(createStoryViewModel(payload)));
  });

  test("a live stored part wins over the defaults", () => {
    const payload = demoAppSource().payload;
    const mid = payload.path[Math.floor(payload.path.length / 2)]!;
    const view = createStoryViewModel(payload);
    expect(openingFocusIndex(payload, mid.id)).toBe(rowIndexForNode(view, mid.id));
  });

  test("remember and forget only change the map when needed", () => {
    const source = demoAppSource();
    const view = createStoryViewModel(source.payload);
    const part = source.payload.path[0]!;
    const focus = rowIndexForNode(view, part.id);
    const once = rememberReadingPosition(source.config, source.payload.id, view, focus);
    expect(once.readingPositions[source.payload.id]).toBe(part.id);
    expect(rememberReadingPosition(once, source.payload.id, view, focus)).toBe(once);
    const cleared = forgetReadingPosition(once, source.payload.id);
    expect(cleared.readingPositions[source.payload.id]).toBeUndefined();
    expect(forgetReadingPosition(cleared, source.payload.id)).toBe(cleared);
  });

  test("rememberFocus is a no-op in demo mode so navigation stays light", () => {
    const source = demoAppSource();
    const state = {
      ...source,
      config: { ...source.config, readingPositions: {} },
      focusIndex: 0,
      stream: null,
      demo: true,
      payload: source.payload
    } as never;
    const before = state.config;
    rememberFocus(state, source);
    expect(state.config).toBe(before);
    flushReadingPositionPersist();
  });
});
