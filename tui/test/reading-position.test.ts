import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTER_OPENING_STORY_ID } from "../../shared/starter-vault.js";
import { demoAppSource } from "../src/demo.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForNode } from "../src/model.js";
import {
  forgetReadingPosition,
  openingFocusIndex,
  putReadingPosition
} from "../src/reading-position.js";
import {
  flushReadingPositionPersist,
  loadReadingPositions,
  markReadingPositionDirty,
  saveReadingPositions
} from "../src/reading-position-store.js";
import { rememberFocus } from "../src/reading-position-persist.js";
import { initialState } from "../src/app.js";

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

  test("pure map put and forget only change when needed", () => {
    const source = demoAppSource();
    const view = createStoryViewModel(source.payload);
    const part = source.payload.path[0]!;
    const focus = rowIndexForNode(view, part.id);
    const once = putReadingPosition({}, source.payload.id, view, focus, source.payload);
    expect(once[source.payload.id]).toBe(part.id);
    expect(putReadingPosition(once, source.payload.id, view, focus, source.payload)).toBe(once);
    const cleared = forgetReadingPosition(once, source.payload.id);
    expect(cleared[source.payload.id]).toBe(undefined);
    expect(forgetReadingPosition(cleared, source.payload.id)).toBe(cleared);
  });

  test("store merge-write keeps peer keys for other stories", () => {
    const directory = mkdtempSync(join(tmpdir(), "1667-reading-"));
    const file = join(directory, "reading-positions.json");
    saveReadingPositions({ "story-a": "part-1", "story-b": "part-2" }, { file });
    markReadingPositionDirty("story-a", "part-1b", { file });
    flushReadingPositionPersist({ file });
    expect(loadReadingPositions({ file })).toEqual({
      "story-a": "part-1b",
      "story-b": "part-2"
    });
    markReadingPositionDirty("story-b", null, { file });
    flushReadingPositionPersist({ file });
    expect(loadReadingPositions({ file })).toEqual({ "story-a": "part-1b" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "story-a": "part-1b" });
  });

  test("rememberFocus is a no-op in demo mode so navigation stays light", () => {
    const source = demoAppSource();
    const state = initialState(source, false);
    expect(state.demo).toBe(true);
    const before = state.readingPositions;
    rememberFocus(state, source);
    expect(state.readingPositions).toBe(before);
    flushReadingPositionPersist();
  });
});
