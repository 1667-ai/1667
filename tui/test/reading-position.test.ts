import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STARTER_OPENING_STORY_ID } from "../../shared/starter-vault.js";
import { demoAppSource } from "../src/demo.js";
import { createStoryViewModel, lastPartRowIndex, rowIndexForNode } from "../src/model.js";
import {
  forgetReadingPosition,
  MAX_READING_POSITIONS,
  mergeReadingPositionDirty,
  openingFocusIndex,
  putReadingPosition
} from "../src/reading-position.js";
import {
  configureReadingPositionStore,
  disposeReadingPositionStore,
  flushReadingPositionPersist,
  loadReadingPositions,
  markReadingPositionDirty,
  readingPositionStoreFile,
  readingPositionStorePathForScope,
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

  test("pending store writes stay with their target file", () => {
    const directory = mkdtempSync(join(tmpdir(), "1667-reading-scopes-"));
    const first = join(directory, "first.json");
    const second = join(directory, "second.json");
    saveReadingPositions({ "first-peer": "part-a" }, { file: first });
    saveReadingPositions({ "second-peer": "part-b" }, { file: second });

    markReadingPositionDirty("first-story", "part-1", { file: first });
    markReadingPositionDirty("second-story", "part-2", { file: second });
    flushReadingPositionPersist({ file: first });
    flushReadingPositionPersist({ file: second });

    expect(loadReadingPositions({ file: first })).toEqual({
      "first-peer": "part-a",
      "first-story": "part-1"
    });
    expect(loadReadingPositions({ file: second })).toEqual({
      "second-peer": "part-b",
      "second-story": "part-2"
    });
  });

  test("merge at capacity keeps the newly dirty story", () => {
    const disk: Record<string, string> = {};
    for (let index = 0; index < MAX_READING_POSITIONS; index += 1) {
      disk[`story-${index}`] = `part-${index}`;
    }
    const dirty = new Map<string, string | null>([["story-new", "part-new"]]);
    const merged = mergeReadingPositionDirty(disk, dirty);
    expect(merged["story-new"]).toBe("part-new");
    expect(Object.keys(merged).length).toBe(MAX_READING_POSITIONS);
  });

  test("each vault scope hashes to its own user-local store file", () => {
    const a = readingPositionStoreFile("/tmp/project-a/.1667", null);
    const b = readingPositionStoreFile("/tmp/project-b/.1667", null);
    const http = readingPositionStoreFile(null, "http://127.0.0.1:1667");
    const httpSame = readingPositionStoreFile(null, "http://127.0.0.1:1667");
    expect(a).toContain("reading-positions");
    expect(a).not.toBe(b);
    expect(http).not.toBe(a);
    expect(http).toBe(httpSame);
    expect(readingPositionStorePathForScope("http:x")).toContain("reading-positions");
  });

  test("integration: navigate, dispose, reload reopens the stored part", () => {
    const directory = mkdtempSync(join(tmpdir(), "1667-reading-int-"));
    const file = join(directory, "store.json");
    configureReadingPositionStore(file);
    const source = demoAppSource();
    // Non-demo so rememberFocus persists.
    source.demo = false;
    source.readingPositions = {};
    const mid = source.payload.path[Math.floor(source.payload.path.length / 2)]!;
    const state = initialState(source, false);
    state.demo = false;
    const view = createStoryViewModel(state.payload);
    state.focusIndex = rowIndexForNode(view, mid.id);
    rememberFocus(state, source);
    disposeReadingPositionStore();
    configureReadingPositionStore(file);
    const reopened = {
      ...source,
      demo: false,
      readingPositions: loadReadingPositions({ file })
    };
    const next = initialState(reopened, false);
    expect(next.focusIndex).toBe(rowIndexForNode(createStoryViewModel(reopened.payload), mid.id));
  });

  test("mkdir failure on a read-only parent does not throw during flush", () => {
    const directory = mkdtempSync(join(tmpdir(), "1667-reading-ro-"));
    const file = join(directory, "nested", "reading-positions.json");
    // Make the parent non-writable so nested mkdir fails.
    chmodSync(directory, 0o500);
    try {
      configureReadingPositionStore(file);
      markReadingPositionDirty("story-a", "part-1", { file });
      let thrown: unknown = null;
      try {
        flushReadingPositionPersist({ file });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(null);
    } finally {
      chmodSync(directory, 0o700);
    }
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
