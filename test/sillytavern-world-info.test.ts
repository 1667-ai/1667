import assert from "node:assert/strict";
import test from "node:test";
import { factsFromArchive, parseLorebookArchive } from "../shared/novelai-lorebook.js";
import { isWorldInfo } from "../shared/sillytavern-world-info.js";
import { fidelityReport } from "../shared/fidelity.js";

/** The shape SillyTavern writes: entries keyed by uid, not a list. */
function worldInfo(entries: Record<string, unknown>[]): string {
  return JSON.stringify({
    entries: Object.fromEntries(entries.map((entry, index) => [String(index), {
      uid: index,
      key: [],
      keysecondary: [],
      comment: "",
      content: "",
      constant: false,
      disable: false,
      order: 100,
      position: 0,
      selective: true,
      probability: 100,
      useProbability: true,
      ...entry
    }]))
  });
}

test("a World Info file is told apart from a NovelAI lorebook by shape", () => {
  assert.equal(isWorldInfo(JSON.parse(worldInfo([]))), true);
  assert.equal(isWorldInfo({ lorebookVersion: 6, entries: [] }), false);
  assert.equal(isWorldInfo({ entries: [] }), false, "a list is a NovelAI lorebook");
  assert.equal(isWorldInfo("text"), false);
});

test("World Info entries become Facts through the one Entry Mapping", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    {
      comment: "Weather",
      content: "The pass closes in winter.",
      key: ["storm", "snow"],
      constant: false
    },
    {
      comment: "Premise",
      content: "The keeper never leaves the light.",
      constant: true
    },
    { comment: "Retired", content: "Not in play.", disable: true }
  ])));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts.length, 2, "a disabled entry does not arrive");
  assert.deepEqual(result.facts[0], {
    tag: "Weather",
    text: "The pass closes in winter.",
    activation: "keyed",
    keys: ["storm", "snow"]
  });
  assert.deepEqual(result.facts[1], {
    tag: "Premise",
    text: "The keeper never leaves the light.",
    activation: "always",
    keys: []
  });
  assert.match(fidelityReport(result.fidelity), /1 disabled entry skipped/u);
});

test("the mechanisms a Fact has no place for are named, not approximated", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    {
      comment: "Secondary",
      content: "Fires on two lists.",
      key: ["storm"],
      keysecondary: ["night"]
    },
    {
      comment: "Chance",
      content: "Fires sometimes.",
      key: ["coin"],
      probability: 40,
      useProbability: true
    },
    {
      comment: "Recursive",
      content: "Feeds itself.",
      key: ["mirror"],
      preventRecursion: true
    }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  for (const reason of [
    "1 entry lost secondary keys; a fact keys on one list",
    "3 insertion positions omitted",
    "1 entry will always fire; a fact has no probability",
    "1 recursion setting omitted",
    "scan depth, order, and other World Info settings omitted"
  ]) assert.ok(report.includes(reason), `${reason} missing from: ${report}`);
});

test("a World Info entry keeps the caps and the reporting every archive gets", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "  padded  ",
    content: "  a body  ",
    key: [" storm ", "storm"]
  }])));

  const result = factsFromArchive(archive, 128);
  const report = fidelityReport(result.fidelity);

  assert.equal(result.facts[0]?.tag, "padded");
  assert.equal(result.facts[0]?.text, "a body");
  // " storm " trims to "storm", which the entry already has.
  assert.deepEqual(result.facts[0]?.keys, ["storm"]);
  assert.ok(report.includes("1 tag trimmed of surrounding whitespace"), report);
  assert.ok(report.includes("1 fact body trimmed of surrounding whitespace"), report);
  assert.ok(report.includes("1 key dropped"), report);
});

test("a character card names its own door instead of failing as a lorebook", () => {
  const card = parseLorebookArchive(Buffer.from(JSON.stringify({
    name: "Mira",
    description: "A lantern keeper.",
    personality: "Steady."
  })));

  assert.throws(
    () => factsFromArchive(card, 128),
    /this is a character card, not a lorebook/u
  );
});

test("a V2 character card is recognised through its spec field", () => {
  const card = parseLorebookArchive(Buffer.from(JSON.stringify({
    spec: "chara_card_v2",
    data: { name: "Mira", description: "A lantern keeper." }
  })));

  assert.throws(() => factsFromArchive(card, 128), /character card/u);
});

test("an unknown JSON object names both archives it could have been", () => {
  const other = parseLorebookArchive(Buffer.from(JSON.stringify({ something: "else" })));

  assert.throws(
    () => factsFromArchive(other, 128),
    /expected a NovelAI lorebook or a SillyTavern World Info file/u
  );
});

test("a regular expression key is dropped and named, not kept as literal text", () => {
  // SillyTavern reads /pattern/flags as a regex. Kept as a literal key it would
  // fire only on the pattern's own text, which is worse than not being there.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Weather",
    content: "The pass closes.",
    key: ["/storm(s|y)?/i", "snow"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.deepEqual(result.facts[0]?.keys, ["snow"]);
  assert.ok(
    fidelityReport(result.fidelity).includes(
      "1 regular expression key dropped; a fact key is literal"
    ),
    fidelityReport(result.fidelity)
  );
});

test("an entry whose keys are all regular expressions says it will not activate", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Weather",
    content: "The pass closes.",
    key: ["/storm/i"]
  }])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("1 regular expression key dropped"), report);
  assert.ok(report.includes("keyed entries have no keys and will not activate")
    || report.includes("keyed entry has no keys and will not activate"), report);
});

test("delayed recursion counts as a recursion setting", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "Delayed", content: "Second pass only.", key: ["k"], delayUntilRecursion: true },
    { comment: "Depth", content: "Third pass only.", key: ["k2"], delayUntilRecursion: 3 }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("2 recursion settings omitted"), report);
});

test("timed effects and matching rules are named", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "Sticky", content: "Stays a while.", key: ["a"], sticky: 3 },
    { comment: "Cool", content: "Waits a while.", key: ["b"], cooldown: 2 },
    { comment: "Exact", content: "Case matters.", key: ["c"], caseSensitive: true },
    { comment: "Partial", content: "Substring matters.", key: ["d"], matchWholeWords: false }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("2 entries lost a timed effect"), report);
  assert.ok(report.includes("2 entries lost a matching rule"), report);
});

test("a key that only looks like a pattern stays a key", () => {
  // `/(/` does not compile, so SillyTavern reads it as literal text. Deleting
  // it would take away a key that works.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Odd",
    content: "Still a key.",
    key: ["/(/", "/storm/i"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.deepEqual(result.facts[0]?.keys, ["/(/"]);
  assert.ok(
    fidelityReport(result.fidelity).includes("1 regular expression key dropped"),
    fidelityReport(result.fidelity)
  );
});

test("an activation decorator is read and kept out of the fact text", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Forced",
    content: "@@activate\nThe keeper never leaves the light.",
    key: []
  }])));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts[0]?.text, "The keeper never leaves the light.");
  assert.equal(result.facts[0]?.activation, "always", "@@activate means always");
  assert.ok(
    fidelityReport(result.fidelity).includes("1 activation decorator read and removed"),
    fidelityReport(result.fidelity)
  );
});

test("an entry the writer switched off with a decorator does not arrive", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "Off", content: "@@dont_activate\nNot in play.", key: ["k"] },
    { comment: "On", content: "In play.", key: ["j"] }
  ])));

  const result = factsFromArchive(archive, 128);

  assert.deepEqual(result.facts.map((fact) => fact.tag), ["On"]);
  assert.ok(
    fidelityReport(result.fidelity).includes("1 entry skipped for @@dont_activate"),
    fidelityReport(result.fidelity)
  );
});

test("grouped entries say they can now be active together", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "A", content: "One.", key: ["k"], group: "weather" },
    { comment: "B", content: "Two.", key: ["k"], group: "weather" }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("2 grouped entries can now be active together"), report);
});

test("the report states the matching rule for every World Info import", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "Plain", content: "No special settings.", key: ["cat"] }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  // Upstream matching depends on a global setting this file does not carry, so
  // the rule 1667 uses is stated rather than guessed at per entry.
  assert.ok(
    report.includes("a fact key matches a whole key and ignores letter case"),
    report
  );
});

test("a key with a second delimiter or an unsupported flag stays a key", () => {
  // A pattern ends at its first unescaped delimiter, so `/foo/bar/` is literal
  // text upstream. `d` is a host flag SillyTavern does not accept.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Literal",
    content: "Still keys.",
    key: ["/foo/bar/", "/storm/d", "/storm/i", "/a\\/b/i"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.deepEqual(result.facts[0]?.keys, ["/foo/bar/", "/storm/d"]);
  assert.ok(
    fidelityReport(result.fidelity).includes("2 regular expression keys dropped"),
    fidelityReport(result.fidelity)
  );
});

test("a vectorized entry says it lost retrieval by meaning", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Semantic",
    content: "Found by meaning.",
    key: [],
    vectorized: true
  }])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("1 vectorized entry lost retrieval by meaning"), report);
});

test("an entry limited to a character says it now applies everywhere", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    {
      comment: "Scoped",
      content: "Only for Mira.",
      key: ["k"],
      characterFilter: { isExclude: false, names: ["Mira"], tags: [] }
    },
    { comment: "Triggered", content: "Only on continue.", key: ["j"], triggers: ["continue"] }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(
    report.includes("2 entries lost a character or trigger filter and now applies everywhere"),
    report
  );
});
