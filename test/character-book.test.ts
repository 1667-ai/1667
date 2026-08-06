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
  }, "Mira");

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

test("{{char}} and {{user}} expand in a character_book entry, matching the card's core sections", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "{{char}} waits for {{USER}} here.", keys: ["k"] },
      { content: "Retired.", comment: "Off", enabled: false, keys: ["k"] }
    ]
  }, "Liz");

  assert.equal(book.entries[0]?.text, "Liz waits for the protagonist here.");
  // A disabled entry still carries expanded text, even though it never
  // reaches the Entry Mapping as an active Fact.
  assert.equal(book.entries[1]?.text, "Retired.");
});

test("name is preferred over comment for the display name", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "Body.", name: "FromName", comment: "FromComment", keys: ["k"] },
      { content: "Body.", comment: "FromComment", keys: ["j"] }
    ]
  }, "Mira");

  assert.equal(book.entries[0]?.displayName, "FromName");
  assert.equal(book.entries[1]?.displayName, "FromComment");
});

test("secondary keys and selective AND carry through while unsupported settings are named", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "Fires on two lists.", keys: ["storm"], selective: true, secondary_keys: ["night"] },
      { content: "Fires early.", keys: ["a"], insertion_order: 0 },
      { content: "Needs both.", keys: ["b"], selective: true, secondary_keys: ["c"] },
      { content: "Case matters.", keys: ["D"], case_sensitive: true }
    ]
  }, "Mira");

  const report = fidelityReport([...factsFromEntries(book.entries, 128).fidelity, ...book.fidelity]);

  const facts = factsFromEntries(book.entries, 128).facts;
  assert.deepEqual(facts[0]?.secondaryKeys, ["night"]);
  assert.deepEqual(facts[2]?.secondaryKeys, ["c"]);
  assert.equal(facts[2]?.secondaryMode, undefined, "AND is the stored default");
  for (const reason of [
    "1 entry lost a position; a fact lands where 1667 puts facts",
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
  }, "Mira");

  const report = fidelityReport([...factsFromEntries(book.entries, 128).fidelity, ...book.fidelity]);

  assert.ok(report.includes("3 entries lost a position"), report);
});

test("a regex-marked entry keeps valid keys and drops invalid patterns", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Body.", keys: ["/storm(?:s)?/i", "/storm/d"], use_regex: true }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.deepEqual(result.facts[0]?.keys, ["/storm(?:s)?/i"]);
  assert.ok(report.includes("1 key dropped"), report);
});

test("an overlength regex key is dropped rather than truncated", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Body.", keys: ["a".repeat(62)], use_regex: true }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport(result.fidelity);

  assert.deepEqual(result.facts[0]?.keys, []);
  assert.ok(report.includes("1 key dropped"), report);
  assert.ok(!report.includes("key cut to 64 characters"), report);
});

test("secondary keys use the primary-key import validation path", () => {
  const book = entriesFromCharacterBook({
    entries: [{
      content: "Body.",
      keys: ["primary"],
      selective: true,
      secondary_keys: ["  permit  ", "permit", "/(/", "x".repeat(65)]
    }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport(result.fidelity);

  assert.deepEqual(result.facts[0]?.secondaryKeys, ["permit", "x".repeat(64)]);
  assert.ok(report.includes("1 key trimmed of surrounding whitespace"), report);
  assert.ok(report.includes("1 key cut to 64 characters"), report);
  assert.ok(report.includes("2 keys dropped"), report);
});

test("use_regex on an entry with no keys has no report line", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Body.", keys: [], use_regex: true, constant: true }]
  }, "Mira");

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
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.equal(result.facts[0]?.text, "The keeper never leaves the light.");
  assert.ok(report.includes("1 entry lost a position; a fact lands where 1667 puts facts"), report);
  assert.ok(report.includes("1 entry lost a prompt role; a fact speaks as the system"), report);
  assert.ok(!report.includes("V3 decorator"), report);
});

test("a decorator this reader does not classify falls to the generic reason", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@some_future_thing 0\nThe keeper never leaves the light.", keys: ["keeper"] }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.equal(result.facts[0]?.text, "The keeper never leaves the light.");
  assert.ok(report.includes("1 V3 decorator read and removed from the fact text"), report);
});

test("an activation-timing decorator is named as a timed loss", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@activate_only_after 3\nBody.", keys: ["k"] }]
  }, "Mira");

  const report = fidelityReport(book.fidelity);

  assert.ok(report.includes("1 entry lost a timed effect; a fact is judged on every request"), report);
});

test("@@activate makes a character_book entry always-active, the same as World Info", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@activate\nAlways in play.", keys: ["k"] }]
  }, "Mira");

  assert.equal(book.entries[0]?.forceActivation, true);
  assert.equal(book.entries[0]?.text, "Always in play.");
});

test("@@dont_activate suppresses a character_book entry, matching the World Info reader", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "@@dont_activate\nNot in play.", keys: ["k"] },
      { content: "In play.", keys: ["j"] }
    ]
  }, "Mira");

  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0]?.text, "In play.");
  assert.equal(book.sourceCount, 2);
  assert.ok(fidelityReport(book.fidelity).includes("1 entry skipped for @@dont_activate"), fidelityReport(book.fidelity));
});

test("@@activate wins over @@dont_activate in a character_book entry, matching World Info", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@activate\n@@dont_activate\nIn play after all.", keys: ["k"] }]
  }, "Mira");

  assert.equal(book.entries.length, 1);
  assert.equal(book.entries[0]?.forceActivation, true);
});

test("prose that only looks like a decorator once the entry starts elsewhere is untouched", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Some text.\n@@depth 0\nMore text.", keys: ["k"] }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);

  assert.equal(result.facts[0]?.text, "Some text.\n@@depth 0\nMore text.");
});

test("an entry that cannot be read at all is counted, not skipped silently", () => {
  const book = entriesFromCharacterBook({
    entries: ["junk", { content: "Real.", keys: ["k"] }]
  }, "Mira");

  assert.equal(book.sourceCount, 2);
  const result = factsFromEntries(book.entries, 128, undefined, book.sourceCount);

  assert.equal(result.facts.length, 1);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);
  assert.ok(report.includes("1 entry could not be read"), report);
  assert.ok(report.includes("2 entries read"), report);
});

test("a book that is not an object, or has no entries array, reads as empty rather than throwing", () => {
  assert.deepEqual(entriesFromCharacterBook("nonsense", "Mira"), { entries: [], sourceCount: 0, fidelity: [] });
  assert.deepEqual(entriesFromCharacterBook({ name: "Untitled" }, "Mira"), { entries: [], sourceCount: 0, fidelity: [] });
  assert.deepEqual(entriesFromCharacterBook(undefined, "Mira"), { entries: [], sourceCount: 0, fidelity: [] });
});

test("a constant entry is always-active and a keyed entry keeps its keys", () => {
  const book = entriesFromCharacterBook({
    entries: [
      { content: "Always.", constant: true, keys: ["ignored-when-constant"] },
      { content: "Keyed.", keys: ["storm", "snow"] }
    ]
  }, "Mira");

  assert.equal(book.entries[0]?.forceActivation, true);
  assert.equal(book.entries[1]?.forceActivation, false);
  assert.deepEqual(book.entries[1]?.keys, ["storm", "snow"]);
});

test("enabled: false does not arrive, matching the shared disabled-entry rule", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "Off.", keys: ["k"], enabled: false }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);

  assert.equal(result.facts.length, 0);
  assert.ok(fidelityReport(result.fidelity).includes("1 disabled entry skipped"));
});

test("a disabled entry does not report what it would have lost, mirroring World Info", () => {
  // A mechanism an entry never got to use is not a loss. Reporting one for an
  // entry that produced no Fact makes every count untrustworthy — the same
  // defect already fixed in sillytavern-world-info.ts.
  const book = entriesFromCharacterBook({
    entries: [{
      content: "@@depth 0\n@@role assistant\nNot in play.",
      keys: ["k"],
      enabled: false,
      insertion_order: 0,
      secondary_keys: ["night"],
      selective: true,
      case_sensitive: true,
      use_regex: true
    }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.equal(result.facts.length, 0);
  assert.ok(report.includes("1 disabled entry skipped"), report);
  for (const absent of [
    "lost a position",
    "lost a prompt role",
    "lost case-sensitive matching",
    "regular expression",
    "V3 decorator"
  ]) assert.ok(!report.includes(absent), `${absent} should not be reported: ${report}`);
});

test("a refused entry does not report a decorator loss it never used either", () => {
  // `@@dont_activate` is itself read from a decorator line; the entry must
  // not additionally report the generic decorator loss for it.
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@dont_activate\nNot in play.", keys: ["k"] }]
  }, "Mira");

  const report = fidelityReport(book.fidelity);

  assert.ok(report.includes("1 entry skipped for @@dont_activate"), report);
  assert.ok(!report.includes("V3 decorator"), report);
});

test("book-level scan_depth, token_budget, and recursive_scanning are each named when present", () => {
  const withSettings = entriesFromCharacterBook({
    entries: [{ content: "Body.", keys: ["k"] }],
    scan_depth: 4,
    token_budget: 512,
    recursive_scanning: true
  }, "Mira");
  const report = fidelityReport(withSettings.fidelity);

  assert.equal(factsFromEntries(withSettings.entries, 128).facts[0]?.scanDepth, 4);
  assert.ok(report.includes("token budget omitted"), report);
  assert.ok(!report.includes("recursive scanning"), report);

  const withoutSettings = entriesFromCharacterBook({
    entries: [{ content: "Body.", keys: ["k"] }]
  }, "Mira");
  const bareReport = fidelityReport(withoutSettings.fidelity);

  for (const absent of ["scan depth", "token budget", "recursive scanning"]) {
    assert.ok(!bareReport.includes(absent), `${absent} should not be reported: ${bareReport}`);
  }
});

test("key-changing decorators are named as a key loss, not the generic one", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@additional_keys lantern,dark\nBody.", keys: ["k"] }]
  }, "Mira");

  const report = fidelityReport(book.fidelity);

  assert.ok(report.includes("1 entry lost added or excluded decorator keys"), report);
  assert.ok(!report.includes("V3 decorator"), report);
});

test("a per-entry scan depth is named as a search-range loss", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@scan_depth 4\nBody.", keys: ["k"] }]
  }, "Mira");

  const report = fidelityReport(book.fidelity);

  assert.ok(
    report.includes("1 entry lost a per-entry search range; the fact uses the book scan depth or the default"),
    report
  );
  assert.ok(!report.includes("V3 decorator"), report);
});

test("an entry the card marked as a greeting says so and still imports", () => {
  const book = entriesFromCharacterBook({
    entries: [{ content: "@@is_greeting 0\nHello, traveller.", keys: ["k"] }]
  }, "Mira");

  const result = factsFromEntries(book.entries, 128);
  const report = fidelityReport([...result.fidelity, ...book.fidelity]);

  assert.equal(result.facts[0]?.text, "Hello, traveller.", "the entry still arrives");
  assert.ok(
    report.includes("1 entry marked as a greeting or an icon; each imports as an ordinary fact"),
    report
  );
});
