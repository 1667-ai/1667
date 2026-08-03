import assert from "node:assert/strict";
import test from "node:test";
import {
  attributionAfterHumanEdit,
  attributionAfterReplacement,
  humanEditAttribution,
  rewrittenSpansAfterHumanEdit,
  rewrittenSpansAfterReplacement
} from "../shared/human-edit.js";

test("human edit attribution marks separate inserted and replaced spans", () => {
  const before = "The old door creaked. Rain crossed the glass.";
  const after = "The blue door creaked twice. Rain crossed the green glass.";
  const attribution = humanEditAttribution(before, after);

  assert.equal(attribution.source, "human");
  assert.deepEqual(
    attribution.ranges.map((range) => after.slice(range.start, range.end)),
    ["blue", "twice", "green"]
  );
  assert.equal(attribution.deletedCharacters, 2);
  assert.equal(humanEditAttribution("One", "One more").deletedCharacters, undefined);
});

test("human edit attribution counts visible characters removed from deletion-only variants", () => {
  const replacement = humanEditAttribution("A😀B", "A✨B");
  assert.deepEqual(replacement.ranges, [{ start: 1, end: 2 }]);
  assert.equal(replacement.deletedCharacters, 1);

  const deletion = humanEditAttribution("Keep this word.", "Keep word.");
  assert.deepEqual(deletion, { source: "human", ranges: [], deletedCharacters: 5 });
  assert.deepEqual(humanEditAttribution("one  space", "one space"), {
    source: "human", ranges: [], deletedCharacters: 1
  });
  assert.equal(humanEditAttribution("A👨‍👩‍👧‍👦B", "AB").deletedCharacters, 1);
});

test("human edit attribution keeps distant edits precise in long parts", () => {
  const words = Array.from({ length: 3_000 }, (_, index) => `word${index}`);
  const changed = [...words];
  changed[100] = "first-change";
  changed[2_900] = "last-change";
  const before = words.join(" ");
  const after = changed.join(" ");

  assert.deepEqual(
    humanEditAttribution(before, after).ranges.map((range) => after.slice(range.start, range.end)),
    ["first-change", "last-change"]
  );
});

test("successive human edits preserve earlier spans and add later changes", () => {
  const generated = "The blue door opened. Rain crossed the glass.";
  const firstEdit = "The red door opened. Rain crossed the glass.";
  const secondEdit = "The red door opened quietly. Rain crossed the glass.";
  const first = humanEditAttribution(generated, firstEdit);
  const second = attributionAfterHumanEdit(first, firstEdit, secondEdit);

  assert.deepEqual(
    second.ranges.map((range) => secondEdit.slice(range.start, range.end)),
    ["red", "quietly"]
  );
  assert.equal(second.deletedCharacters, 3);
});

test("human edit attribution bounds pathological range counts with a valid fallback", () => {
  const beforeWords = Array.from({ length: 600 }, (_, index) => `word${index}`);
  const afterWords = beforeWords.flatMap((word, index) => index < 300 ? [word, `inserted${index}`] : [word]);
  const before = beforeWords.join(" ");
  const after = afterWords.join(" ");
  const attribution = humanEditAttribution(before, after);

  assert.equal(attribution.ranges.length, 1);
  assert.ok(attribution.ranges[0]!.start < attribution.ranges[0]!.end);
  assert.match(after.slice(attribution.ranges[0]!.start, attribution.ranges[0]!.end), /inserted0/);
});

test("model replacements shift only surviving human ranges", () => {
  const attribution = {
    source: "human" as const,
    ranges: [{ start: 2, end: 8 }, { start: 12, end: 16 }],
    deletedCharacters: 4
  };
  assert.deepEqual(attributionAfterReplacement(attribution, 5, 14, 3, 20), {
    source: "human",
    ranges: [{ start: 2, end: 5 }, { start: 8, end: 10 }],
    deletedCharacters: 4
  });
  assert.equal(attributionAfterReplacement(attribution, 0, 20, 4, 20), null);
  assert.equal(attributionAfterReplacement(attribution, 0, 18, 4, 20), null);
  assert.deepEqual(attributionAfterReplacement({
    source: "human", ranges: [], deletedCharacters: 9
  }, 0, 18, 4, 20), {
    source: "human",
    ranges: [],
    deletedCharacters: 9
  });
});

test("rewritten spans after replacement carry earlier spans, shifted, and add the new one", () => {
  const spans = [{ start: 2, end: 6 }, { start: 20, end: 24 }];
  const after = rewrittenSpansAfterReplacement(spans, 10, 14, 2);
  assert.deepEqual(after, [
    { start: 2, end: 6 },
    { start: 10, end: 12 },
    { start: 18, end: 22 }
  ]);
});

test("rewritten spans after replacement merge a carried remnant into the new span when they touch", () => {
  // The replacement window sits in the middle of an earlier span, so what
  // survives on either side and the fresh span in between are contiguous —
  // boundedRanges merges them into one span rather than three.
  const after = rewrittenSpansAfterReplacement([{ start: 0, end: 10 }], 4, 8, 8);
  assert.deepEqual(after, [{ start: 0, end: 14 }]);
});

test("rewritten spans after replacement leave unrelated spans as separate, untouched ranges", () => {
  const after = rewrittenSpansAfterReplacement([{ start: 0, end: 3 }, { start: 7, end: 10 }], 4, 6, 1);
  assert.deepEqual(after, [{ start: 0, end: 3 }, { start: 4, end: 5 }, { start: 6, end: 9 }]);
});

test("rewritten spans after replacement start from nothing when no earlier spans exist", () => {
  assert.deepEqual(rewrittenSpansAfterReplacement(undefined, 3, 3, 5), [{ start: 3, end: 8 }]);
  assert.deepEqual(rewrittenSpansAfterReplacement(null, 3, 3, 5), [{ start: 3, end: 8 }]);
});

test("rewritten spans move through a later human edit without losing the model's words", () => {
  const before = "The old door creaked once.";
  const spans = [{ start: before.indexOf("door"), end: before.indexOf("door") + "door".length }];
  const after = "Slowly, the old door creaked once.";
  const moved = rewrittenSpansAfterHumanEdit(spans, before, after);
  assert.deepEqual(moved.map((range) => after.slice(range.start, range.end)), ["door"]);
});

test("writing over part of a rewritten span reclaims only the words the writer changed", () => {
  const before = "The old door creaked once.";
  const start = before.indexOf("old door");
  const spans = [{ start, end: start + "old door".length }];
  const after = "The old gate creaked once.";
  const remaining = rewrittenSpansAfterHumanEdit(spans, before, after);
  // "gate" is the writer's word now; "old" stays a rewritten span.
  assert.deepEqual(remaining.map((range) => after.slice(range.start, range.end)), ["old"]);
});

test("writing over the entire rewritten span reclaims all of it", () => {
  const before = "The old door creaked once.";
  const start = before.indexOf("door");
  const spans = [{ start, end: start + "door".length }];
  const after = "The old gate creaked once.";
  assert.deepEqual(rewrittenSpansAfterHumanEdit(spans, before, after), []);
});

test("rewrittenSpansAfterHumanEdit returns an empty array, not a span, when there were none to begin with", () => {
  // The empty array here is this function's own honest return value, not a
  // claim that a saved node's `rewrittenSpans` field goes missing — that
  // absence is `applyHumanEdit`'s job (server/story-nodes.ts), which deletes
  // the field rather than storing `[]`; "story store: editing a node that
  // fully reclaims its rewritten span deletes the field" (story-store.test.ts)
  // exercises that instead.
  assert.deepEqual(rewrittenSpansAfterHumanEdit(undefined, "One.", "One and two."), []);
  assert.deepEqual(rewrittenSpansAfterHumanEdit(null, "One.", "One and two."), []);
});
