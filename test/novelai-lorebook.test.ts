import assert from "node:assert/strict";
import test from "node:test";
import {
  factsFromLorebook,
  parseLorebookArchive,
  SUPPORTED_LOREBOOK_VERSION
} from "../shared/novelai-lorebook.js";
import { createFacts } from "../server/story-facts.js";
import { fidelityReport } from "../shared/fidelity.js";
import { MAX_JSON_BODY_BYTES, type Story } from "../shared/types.js";

test("factsFromLorebook maps every row of the §2.2 table", () => {
  const lorebook = {
    lorebookVersion: 6,
    categories: [
      { id: "cat:people", name: "People" }
    ],
    entries: [
      // Row 1: enabled: false -> skipped
      { enabled: false, text: "Disabled entry", displayName: "Disabled" },
      // Row 2: text normalisation, trim, surrogates, cap
      {
        enabled: true,
        text: "  Line 1\r\nLine 2\rLine 3\u2028Line 4\u2029Line 5  ",
        displayName: "Normalised Text"
      },
      // Row 2: empty text after trim -> dropped
      { enabled: true, text: "   ", displayName: "Empty Text" },
      // Row 3 & 4: displayName fallback to category name
      { enabled: true, text: "Character info", category: "cat:people" },
      // Row 3: tag cut over 48 scalars
      { enabled: true, text: "Long tag entry", displayName: "A".repeat(60) },
      // Row 5: keys cleaning (strings only, trim, drop empty, comma, line breaks, cut 64 scalars, dedupe normalized, max 32)
      {
        enabled: true,
        text: "Keyed entry",
        displayName: "Keyed",
        forceActivation: false,
        keys: [
          123, // non-string -> drop
          "   ", // empty trim -> drop
          "valid key",
          "key,with,comma", // comma -> drop
          "key\nwith\nnewline", // line break -> drop
          "K".repeat(80), // cut to 64
          "VALID KEY", // duplicate normalized -> drop
          "second key"
        ]
      },
      // Row 6: forceActivation true -> always, false -> keyed
      { enabled: true, text: "Always active entry", forceActivation: true }
    ]
  };

  const result = factsFromLorebook(lorebook, 128);
  assert.equal(result.facts.length, 5);

  // Normalised text entry
  assert.equal(result.facts[0]?.text, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5");
  assert.equal(result.facts[0]?.tag, "Normalised Text");

  // Category fallback entry
  assert.equal(result.facts[1]?.tag, "People");

  // Tag cut entry
  assert.equal(result.facts[2]?.tag, "A".repeat(48));

  // Keyed entry with cleaned keys
  assert.equal(result.facts[3]?.activation, "keyed");
  assert.deepEqual(result.facts[3]?.keys, ["valid key", "K".repeat(64), "second key"]);

  // Always active entry
  assert.equal(result.facts[4]?.activation, "always");
});

test("fidelity report text for a Lorebook that fires every counter at once asserts exact string", () => {
  const allEntries: any[] = [];

  // 3 disabled
  allEntries.push({ enabled: false, text: "d1" });
  allEntries.push({ enabled: false, text: "d2" });
  allEntries.push({ enabled: false, text: "d3" });

  // 2 truncated
  allEntries.push({ enabled: true, forceActivation: true, text: ("Paragraph 1\n\n".repeat(400)) });
  allEntries.push({ enabled: true, forceActivation: true, text: ("Paragraph 2\n\n".repeat(400)) });

  // 1 tag cut
  allEntries.push({ enabled: true, forceActivation: true, text: "tag test", displayName: "T".repeat(60) });

  // 2 keyed no keys
  allEntries.push({ enabled: true, forceActivation: false, text: "nk1", keys: [","] });
  allEntries.push({ enabled: true, forceActivation: false, text: "nk2", keys: ["\n"] });

  // 26 always active entries
  for (let i = 0; i < 26; i++) {
    allEntries.push({ enabled: true, forceActivation: true, text: `Fact ${i}` });
  }

  // 7 excess entries that won't fit limit (total 3 + 2 + 1 + 2 + 26 + 7 = 41 entries read)
  for (let i = 0; i < 7; i++) {
    allEntries.push({ enabled: true, forceActivation: true, text: `Excess ${i}` });
  }

  const lorebook = {
    lorebookVersion: 6,
    entries: allEntries
  };

  // room = 34 facts imported out of 38 enabled entries (34 imported + 7 excess = 41 valid entries)
  const importResult = factsFromLorebook(lorebook, 34);
  const formattedReport = fidelityReport(importResult.fidelity);

  const expected = "41 entries read; 34 facts imported; 3 disabled entries skipped; 2 entries truncated to 4,000 characters; 2 fact bodies trimmed of surrounding whitespace; 1 tag cut to 48 characters; 2 keys dropped; 2 keyed entries have no keys and will not activate; 4 entries did not fit the 128-fact limit; search range, bias groups, and advanced conditions omitted";
  assert.equal(formattedReport, expected);

});

test("oversized entry is cut on a paragraph boundary, never between surrogates, and createFacts accepts it", () => {
  const paragraph1 = "A".repeat(2_000);
  const paragraph2 = "B".repeat(1_500);
  const paragraph3 = "C".repeat(1_000);
  // Total length = 2000 + 2 + 1500 + 2 + 1000 = 4504 UTF-16 code units
  const oversizedText = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

  const lorebook = {
    lorebookVersion: 6,
    entries: [{ enabled: true, text: oversizedText, displayName: "Oversized" }]
  };

  const importResult = factsFromLorebook(lorebook, 128);
  assert.equal(importResult.facts.length, 1);
  const fact = importResult.facts[0]!;

  // Must be cut at paragraph break before 4,000 code units (which is paragraph1 + \n\n + paragraph2 = 3502 code units)
  assert.equal(fact.text, `${paragraph1}\n\n${paragraph2}`);
  assert.ok(fact.text.length <= 4000);

  // Assert createFacts accepts it without throwing
  const mockStory: Story = {
    id: "test-story",
    title: "Test Story",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
    activeRootId: null,
    recentNodeIds: [],
    tags: [],
    facts: [],
    chapterBreaks: []
  };

  const accepted = createFacts(mockStory, { facts: [fact] }, (i) => `fact-${i}`);
  assert.equal(accepted, true);
  assert.equal(mockStory.facts.length, 1);
});

test("parseLorebookArchive validates format, PNG embedding, and version", () => {
  assert.throws(() => parseLorebookArchive(new Uint8Array(0)), /Lorebook file is empty/);

  const invalidVersion = JSON.stringify({ lorebookVersion: 7 });
  const lorebook = parseLorebookArchive(Buffer.from(invalidVersion));
  assert.throws(() => factsFromLorebook(lorebook, 128), /unsupported lorebookVersion 7/);
});

test("an entry whose text holds an unpaired surrogate is dropped and named, and the rest of the lorebook still imports", () => {
  const result = factsFromLorebook({
    lorebookVersion: SUPPORTED_LOREBOOK_VERSION,
    entries: [
      { enabled: true, text: "a good entry", displayName: "good" },
      { enabled: true, text: "broken \ud800 entry", displayName: "bad" },
      { enabled: true, text: "another good entry", displayName: "good two" }
    ]
  }, 128);

  assert.equal(result.facts.length, 2);
  assert.deepEqual(result.facts.map((fact) => fact.tag), ["good", "good two"]);
  assert.ok(
    fidelityReport(result.fidelity).includes("1 entry dropped for invalid Unicode"),
    fidelityReport(result.fidelity)
  );
});

test("an entry whose tag holds an unpaired surrogate keeps its text and loses only the tag", () => {
  const result = factsFromLorebook({
    lorebookVersion: SUPPORTED_LOREBOOK_VERSION,
    entries: [{ enabled: true, text: "the keeper trims the wick", displayName: "bad \udfff tag" }]
  }, 128);

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]!.tag, null);
  assert.equal(result.facts[0]!.text, "the keeper trims the wick");
});

test("facts dropped for the request body limit are named separately from the fact ceiling", () => {
  // The body is measured in UTF-8 bytes but the Fact text cap counts UTF-16
  // code units, so only multi-byte prose can reach the ceiling and still
  // overflow the request. 128 x 4,000 three-byte characters is 1.5 MB.
  const entries = Array.from({ length: 128 }, (_unused, index) => ({
    enabled: true,
    text: `${index} `.padEnd(4_000, "銀"),
    displayName: `tag ${index}`
  }));

  const report = fidelityReport(
    factsFromLorebook(
      { lorebookVersion: SUPPORTED_LOREBOOK_VERSION, entries },
      128,
      MAX_JSON_BODY_BYTES
    ).fidelity
  );

  assert.ok(report.includes("dropped to fit the 1 MB request limit"), report);
  assert.ok(!report.includes("did not fit the 128-fact limit"), report);
});

test("a container import keeps every fact, because it sends no request", () => {
  // The same lorebook that overflows a createFact body imports whole when the
  // story is built in process. A request limit must not shrink a round trip
  // that never made a request.
  const entries = Array.from({ length: 128 }, (_unused, index) => ({
    enabled: true,
    text: `${index} `.padEnd(4_000, "銀"),
    displayName: `tag ${index}`
  }));

  const result = factsFromLorebook(
    { lorebookVersion: SUPPORTED_LOREBOOK_VERSION, entries },
    128
  );

  assert.equal(result.facts.length, 128);
  assert.ok(!fidelityReport(result.fidelity).includes("1 MB request limit"));
});

test("a lorebook PNG reports a lorebook error and never a character-card error", () => {
  // A PNG signature with no chunks at all fails the structural walk.
  const truncated = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0]);

  assert.throws(
    () => parseLorebookArchive(truncated),
    (error: Error) => error.message.startsWith("Lorebook PNG") && !error.message.includes("Character card")
  );
});

test("a trimmed fact body is named, because 1667 stores fact text exactly", () => {
  const result = factsFromLorebook({
    lorebookVersion: SUPPORTED_LOREBOOK_VERSION,
    entries: [
      { enabled: true, text: "  indented and padded  ", displayName: "padded" },
      { enabled: true, text: "already exact", displayName: "exact" }
    ]
  }, 128);

  assert.equal(result.facts[0]?.text, "indented and padded");
  assert.ok(
    fidelityReport(result.fidelity).includes("1 fact body trimmed of surrounding whitespace"),
    fidelityReport(result.fidelity)
  );
});

test("a trimmed key is named, because spacing decides when a keyed fact activates", () => {
  // A key is matched literally in the scanned text and normalization folds
  // case but not spacing, so " storm " is a narrower matcher than "storm".
  const result = factsFromLorebook({
    lorebookVersion: SUPPORTED_LOREBOOK_VERSION,
    entries: [{
      enabled: true,
      text: "The pass closes.",
      displayName: "weather",
      keys: [" storm ", "lantern"]
    }]
  }, 128);

  assert.deepEqual(result.facts[0]?.keys, ["storm", "lantern"]);
  assert.ok(
    fidelityReport(result.fidelity).includes("1 key trimmed of surrounding whitespace"),
    fidelityReport(result.fidelity)
  );
});
