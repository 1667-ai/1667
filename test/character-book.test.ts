import assert from "node:assert/strict";
import test from "node:test";
import { entriesFromCharacterBook } from "../shared/character-book.js";
import { factsFromEntries } from "../shared/lorebook-entry.js";
import { fidelityReport } from "../shared/fidelity.js";

test("a character_book entry maps to a Fact through the shared Entry Mapping", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "The pass closes in winter.", name: "Weather", keys: ["storm", "snow"] },
      { content: "The keeper never leaves the light.", comment: "Premise", constant: true },
      { content: "Retired.", comment: "Off", enabled: false }
    ]
  });

  assert.equal(book.sourceCount, 3);
  const result = factsFromEntries(book.entries, 128);

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
});

test("name is preferred over comment for the display name", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "Body.", name: "FromName", comment: "FromComment", keys: ["k"] },
      { content: "Body.", comment: "FromComment", keys: ["j"] }
    ]
  });

  assert.equal(book.entries[0]?.displayName, "FromName");
  assert.equal(book.entries[1]?.displayName, "FromComment");
});

test("the mechanisms a Fact has no place for are named, not approximated", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "Fires on two lists.", keys: ["storm"], secondary_keys: ["night"] },
      { content: "Fires early.", keys: ["a"], insertion_order: 0 },
      { content: "Needs both.", keys: ["b"], selective: true, secondary_keys: ["c"] },
      { content: "Case matters.", keys: ["D"], case_sensitive: true }
    ]
  });

  const report = fidelityReport([...factsFromEntries(book.entries, 128).fidelity, ...book.fidelity]);

  for (const reason of [
    "2 entries lost secondary keys; a fact keys on one list",
    "1 entry lost a position; a fact lands where 1667 puts facts",
    "1 entry lost selective matching; a fact has no AND/NOT logic",
    "1 entry lost case-sensitive matching; a fact key ignores letter case"
  ]) assert.ok(report.includes(reason), `${reason} missing from: ${report}`);
});

test("position, insertion_order, and priority are one loss, not three", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "A.", keys: ["a"], position: "before_char" },
      { content: "B.", keys: ["b"], priority: 5 },
      { content: "C.", keys: ["c"], position: "before_char", insertion_order: 1, priority: 2 }
    ]
  });

  const report = fidelityReport([...factsFromEntries(book.entries, 128).fidelity, ...book.fidelity]);

  assert.ok(report.includes("3 entries lost a position"), report);
});

test("a regex-marked entry drops its keys instead of keeping a pattern as literal text", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Body.", keys: ["/storm(s)?/i"], use_regex: true }]
  });

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.deepEqual(result.facts[0]?.keys, []);
  assert.ok(
    report.includes("1 entry marked their keys as a regular expression; a fact key is literal"),
    report
  );
  assert.ok(report.includes("keyed entry has no keys and will not activate"), report);
});

test("use_regex on an entry with no keys reports nothing; there was nothing to lose", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Body.", keys: [], use_regex: true, constant: true }]
  });

  const report = fidelityReport(factsFromEntries(book.entries, 128).fidelity);

  assert.ok(!report.includes("regular expression"), report);
});

test("a leading V3 decorator is stripped from the fact text and named", () => {
  // @@depth and @@role each carry their own reason, matching the granularity
  // WORLD_INFO_LOSS_PHRASES already uses for the same mechanisms.
  const book = entriesFromCharacterBook({
    entries: [{
      content: "@@depth 0\n@@role assistant\nThe keeper never leaves the light.",
      keys: ["keeper"]
    }]
  });

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.equal(result.facts[0]?.text, "The keeper never leaves the light.");
  assert.ok(report.includes("1 entry lost a position; a fact lands where 1667 puts facts"), report);
  assert.ok(report.includes("1 entry lost a prompt role; a fact speaks as the system"), report);
  assert.ok(!report.includes("V3 decorator"), report);
});

test("a decorator this reader does not classify falls to the generic reason", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@is_greeting 0\nThe keeper never leaves the light.", keys: ["keeper"] }]
  });

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.equal(result.facts[0]?.text, "The keeper never leaves the light.");
  assert.ok(report.includes("1 V3 decorator read and removed from the fact text"), report);
});

test("an activation-timing decorator is named as a timed loss", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@activate_only_after 3\nBody.", keys: ["k"] }]
  });

  const report = fidelityReport(book.fidelity);

  assert.ok(report.includes("1 entry lost a timed effect; a fact is judged on every request"), report);
});

test("@@activate makes a character_book entry always-active, the same as World Info", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@activate\nAlways in play.", keys: ["k"] }]
  });

  assert.equal(book.entries[0]?.forceActivation, true);
  assert.equal(book.entries[0]?.text, "Always in play.");
});

test("@@dont_activate suppresses a character_book entry, matching the World Info reader", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "@@dont_activate\nNot in play.", keys: ["k"] },
      { content: "In play.", keys: ["j"] }
    ]
  });

  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0]?.text, "In play.");
  assert.equal(book.sourceCount, 2);
  assert.ok(fidelityReport(book.fidelity).includes("1 entry skipped for @@dont_activate"), fidelityReport(book.fidelity));
});

test("@@activate wins over @@dont_activate in a character_book entry, matching World Info", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@activate\n@@dont_activate\nIn play after all.", keys: ["k"] }]
  });

  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0]?.forceActivation, true);
});

test("prose that only looks like a decorator once the entry starts elsewhere is untouched", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Some text.\n@@depth 0\nMore text.", keys: ["k"] }]
  });

  const result = factsFromEntries(book.entries, 128);

  assert.equal(result.facts[0]?.text, "Some text.\n@@depth 0\nMore text.");
});

test("an entry that cannot be read at all is counted, not skipped silently", () => {
  const book = entriesFromCharacterBook({
    entries: ["junk", { content: "Real.", keys: ["k"] }]
  });

  assert.equal(book.sourceCount, 2);
  const result = factsFromEntries(book.entries, 128, undefined, book.sourceCount);

  assert.equal(result.facts.length, 1);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);
  assert.ok(report.includes("1 entry could not be read"), report);
  assert.ok(report.includes("2 entries read"), report);
});

test("a book that is not an object, or has no entries array, reads as empty rather than throwing", () => {
  assert.deepEqual(entriesFromCharacterBook("nonsense"), { entries: [], sourceCount: 0, fidelity: [] });
  assert.deepEqual(entriesFromCharacterBook({ name: "Untitled" }), { entries: [], sourceCount: 0, fidelity: [] });
  assert.deepEqual(entriesFromCharacterBook(undefined), { entries: [], sourceCount: 0, fidelity: [] });
});

test("a constant entry is always-active and a keyed entry keeps its keys", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "Always.", constant: true, keys: ["ignored-when-constant"] },
      { content: "Keyed.", keys: ["storm", "snow"] }
    ]
  });

  assert.equal(book.entries[0]?.forceActivation, true);
  assert.equal(book.entries[1]?.forceActivation, false);
  assert.deepEqual(book.entries[1]?.keys, ["storm", "snow"]);
});

test("enabled: false does not arrive, matching the shared disabled-entry rule", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Off.", keys: ["k"], enabled: false }]
  });

  const result = factsFromEntries(book.entries, 128);

  assert.equal(result.facts.length, 0);
  assert.ok(fidelityReport(result.fidelity).includes("1 disabled entry skipped"));
});
