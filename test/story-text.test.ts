import assert from "node:assert/strict";
import test from "node:test";
import { appendWordCount, countWords } from "../shared/story-text.js";

test("story text: word counting ignores surrounding whitespace", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  one\n two\tthree  "), 3);
});

test("story text: incremental word counting preserves words across streamed deltas", () => {
  let state = { words: 0, insideWord: false };
  for (const delta of ["  one", "\n", "tw", "o\tthree", "  "]) state = appendWordCount(state, delta);
  assert.deepEqual(state, { words: 3, insideWord: false });
});
