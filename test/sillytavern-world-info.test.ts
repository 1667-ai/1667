import assert from "node:assert/strict";
import test from "node:test";
import { factsFromArchive } from "../shared/archive-import.js";
import { parseLorebookArchive } from "../shared/novelai-lorebook.js";
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

test("a spaced key that looks like a pattern is kept and named", () => {
  // An exact pattern is dropped. A padded one is ambiguous, so it is kept —
  // losing a key can cost an entry its only trigger — and named, so the writer
  // is not left with a key that quietly never fires.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Padded",
    content: "The pass closes.",
    key: ["  /storm/i  ", "snow"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.deepEqual(result.facts[0]?.keys, ["/storm/i", "snow"]);
  const report = fidelityReport(result.fidelity);
  assert.ok(report.includes("1 spaced key looks like a pattern"), report);
  assert.ok(!report.includes("regular expression key dropped"), report);
});

test("an unknown decorator leaves the prose without promoting the entry", () => {
  // Only the exact control counts. A decorator this import does not know must
  // not turn a keyed entry into an always-active Fact on a guess.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Odd",
    content: "@@activate note\nThe keeper waits.",
    key: ["keeper"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts[0]?.text, "The keeper waits.");
  assert.equal(result.facts[0]?.activation, "keyed");
  assert.ok(
    fidelityReport(result.fidelity).includes("1 activation decorator read and removed"),
    fidelityReport(result.fidelity)
  );
});

test("a macro says it arrives unexpanded", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "Content", content: "{{char}} lives here.", key: ["home"] },
    { comment: "Key", content: "Plain text.", key: ["{{user}}"] }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("2 entries kept a {{macro}} unexpanded"), report);
});

test("a World Info file with its own name and description is not read as a card", () => {
  // SillyTavern World Info files carry root metadata. The archive shape decides
  // the format, so the card heuristic never sees a file that already declared.
  const archive = parseLorebookArchive(Buffer.from(JSON.stringify({
    name: "Eldoria",
    description: "World lore",
    entries: {
      "0": { uid: 0, comment: "Capital", content: "The capital is Vale.", key: ["Vale"] }
    }
  })));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.tag, "Capital");
});

test("indented text that looks like a decorator stays prose", () => {
  // Upstream begins decorator processing only when the content itself starts
  // with @@, so an indented line is ordinary writing.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Indented",
    content: "  @@dont_activate is a thing you can write.",
    key: ["thing"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts.length, 1, "the entry is not refused");
  assert.equal(result.facts[0]?.text, "@@dont_activate is a thing you can write.");
  assert.ok(
    !fidelityReport(result.fidelity).includes("@@dont_activate"),
    fidelityReport(result.fidelity)
  );
});

test("a zero recursion delay is no delay", () => {
  // Current files write numeric 0 for "no delay". Counting it would tell every
  // ordinary import that it lost a recursion setting it never had.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "Plain", content: "Ordinary.", key: ["k"], delayUntilRecursion: 0 },
    { comment: "Also plain", content: "Ordinary.", key: ["j"], delayUntilRecursion: false }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(!report.includes("recursion"), report);
});

test("a decorator with a trailing space is not the exact control", () => {
  // Upstream compares the token as written, so a padded decorator is not the
  // suppression control and must not throw the entry away.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Padded",
    content: "@@dont_activate \nThe keeper waits.",
    key: ["keeper"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts.length, 1, "the entry survives");
  assert.equal(result.facts[0]?.activation, "keyed");
  assert.equal(result.facts[0]?.text, "The keeper waits.");
});

test("a decorator this import does not understand leaves the prose and nothing else", () => {
  // Reading a decorator we cannot verify would either drop an entry the writer
  // kept or promote one they did not. Strip it, count it, and let `constant`
  // and the keys decide.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Fallback",
    content: "@@unsupported_thing\n@@@dont_activate\nStill in play.",
    key: ["k"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts.length, 1, "an unknown decorator does not drop the entry");
  assert.equal(result.facts[0]?.text, "Still in play.");
  assert.equal(result.facts[0]?.activation, "keyed");
  const report = fidelityReport(result.fidelity);
  assert.ok(report.includes("activation decorator read and removed"), report);
  assert.ok(!report.includes("skipped for @@dont_activate"), report);
});

test("@@activate wins when both exact controls are present", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Both",
    content: "@@activate\n@@dont_activate\nIn play after all.",
    key: ["k"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.activation, "always");
});

test("an extra scan source is named", () => {
  const archive = parseLorebookArchive(Buffer.from(worldInfo([
    { comment: "Persona", content: "Body.", key: ["k"], matchPersonaDescription: true },
    { comment: "Scenario", content: "Body.", key: ["j"], matchScenario: true }
  ])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("2 entries lost an extra scan source"), report);
});

test("a World Info entry that cannot be read at all is still named", () => {
  const archive = parseLorebookArchive(Buffer.from(JSON.stringify({
    entries: { "0": "junk", "1": { uid: 1, comment: "Real", content: "In play.", key: ["k"] } }
  })));

  const result = factsFromArchive(archive, 128);

  assert.equal(result.facts.length, 1);
  assert.ok(
    fidelityReport(result.fidelity).includes("1 entry could not be read"),
    fidelityReport(result.fidelity)
  );
});

test("a refused entry still counts as one the file held", () => {
  // The headline counts what the writer wrote. Otherwise the report reads
  // "0 entries read" beside a reason for skipping one of them.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Off",
    content: "@@dont_activate\nNot in play.",
    key: ["k"]
  }])));

  const report = fidelityReport(factsFromArchive(archive, 128).fidelity);

  assert.ok(report.includes("1 entry read"), report);
  assert.ok(report.includes("1 entry skipped for @@dont_activate"), report);
  assert.ok(!report.includes("0 entries read"), report);
});

test("a pattern that spans lines is named as a pattern", () => {
  // A slash-delimited key can hold a line break, and the loss reason has to say
  // what it was rather than fall through to the generic key drop.
  const archive = parseLorebookArchive(Buffer.from(worldInfo([{
    comment: "Multiline",
    content: "Body.",
    key: ["/foo\nbar/m", "snow"]
  }])));

  const result = factsFromArchive(archive, 128);

  assert.deepEqual(result.facts[0]?.keys, ["snow"]);
  assert.ok(
    fidelityReport(result.fidelity).includes("1 regular expression key dropped"),
    fidelityReport(result.fidelity)
  );
});
