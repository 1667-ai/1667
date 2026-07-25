import assert from "node:assert/strict";
import test from "node:test";
import {
  attributionAfterHumanEdit,
  attributionAfterReplacement,
  humanEditAttribution
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
