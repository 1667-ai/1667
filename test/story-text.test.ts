import assert from "node:assert/strict";
import test from "node:test";
import { appendContinuationText, appendWordCount, countWords } from "../shared/story-text.js";

test("story text: continuations join at the exact character boundary", () => {
  assert.equal(appendContinuationText("The latch was unlo", "cked."), "The latch was unlocked.");
  assert.equal(appendContinuationText("She raised", " her glass."), "She raised her glass.");
  assert.equal(appendContinuationText("A beat.", "\n\nSilence."), "A beat.\n\nSilence.");
});

test("story text: word counting ignores surrounding whitespace", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  one\n two\tthree  "), 3);
});

test("story text: incremental word counting preserves words across streamed deltas", () => {
  let state = { words: 0, insideWord: false };
  for (const delta of ["  one", "\n", "tw", "o\tthree", "  "]) state = appendWordCount(state, delta);
  assert.deepEqual(state, { words: 3, insideWord: false });
});
