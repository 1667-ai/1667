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
    "scan depth, order, and group weighting omitted"
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
