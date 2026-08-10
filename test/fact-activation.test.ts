import assert from "node:assert/strict";
import test from "node:test";
import { selectActiveFactsWithTrace } from "../shared/fact-activation.js";
import { MAX_FACT_RECURSION_UTF16, MAX_FACT_SCAN_UTF16 } from "../shared/fact-metadata.js";
import { parseFactKeys, splitFactKeyLine } from "../shared/fact-keys.js";
import { compileFactPattern, factPatternMatches } from "../shared/fact-pattern.js";
import type { StoryFact, StoryNode } from "../shared/types.js";

const NOW = "2026-01-01T00:00:00.000Z";

test("fact activation uses Unicode-aware whole-key boundaries", () => {
  const cases: Array<{ key: string; text: string; active: boolean }> = [
    { key: "Café", text: "The CAFE\u0301 waited.", active: true },
    { key: "cat", text: "A cat!", active: true },
    { key: "cat", text: "scatter", active: false },
    { key: "cat", text: "cat_2", active: false },
    { key: "cat", text: "cat\u0301", active: false },
    { key: "cat", text: "𐐀cat", active: false },
    { key: "cat", text: "😀cat", active: true },
    { key: "@hero", text: "@hero arrived.", active: true },
    { key: "@hero", text: "x@hero arrived.", active: false },
    { key: "[hero]", text: "[hero] arrived.", active: true },
    { key: "[hero]", text: "x[hero]y", active: false },
    { key: "猫", text: "黑猫在门后。", active: true },
    { key: "「猫」", text: "黑「猫」在门后。", active: true },
    { key: "猫", text: "x猫", active: false },
    { key: "猫", text: "猫x", active: false }
  ];

  for (const item of cases) {
    const selected = selectActiveFactsWithTrace(
      [fact(item.key)],
      context(item.text)
    ).facts;
    assert.equal(selected.length === 1, item.active, `${item.key} in ${item.text}`);
  }
});

test("fact activation scans only the last three assembled parts and the instruction", () => {
  const facts = [
    fact("forgotten"),
    alwaysFact("standing"),
    fact("instruction key"),
    fact("alpha"),
    fact("recent"),
    { ...fact("unused"), keys: [] }
  ];
  const selected = selectActiveFactsWithTrace(facts, {
    contextParts: [
      part("one", "forgotten"),
      part("two", "alpha"),
      part("three", "recent"),
      part("four", "omega")
    ],
    chapterBreaks: [],
    nodes: [],
    instruction: "Use the instruction key now."
  }).facts;

  assert.deepEqual(selected.map(({ id }) => id), [
    "fact-standing",
    "fact-instruction key",
    "fact-alpha",
    "fact-recent"
  ]);
  assert.deepEqual(
    selectActiveFactsWithTrace(facts).facts.map(({ id }) => id),
    ["fact-standing"]
  );
});

test("the scan cap does not create a false word boundary", () => {
  const text = `xcat ${"z".repeat(MAX_FACT_SCAN_UTF16 - 4)}`;
  assert.equal(selectActiveFactsWithTrace([fact("cat")], context(text)).facts.length, 0);
  assert.equal(
    selectActiveFactsWithTrace(
      [fact("a")],
      context(`z${" ".repeat(MAX_FACT_SCAN_UTF16)}`)
    ).facts.length,
    0,
    "the omitted boundary scalar must not become searchable text"
  );
  assert.equal(
    selectActiveFactsWithTrace(
      [fact("tail key")],
      context(`${"z".repeat(MAX_FACT_SCAN_UTF16)} tail key`)
    ).facts.length,
    1
  );
});

test("regex keys use scalar-safe patterns and slash-aware editor parsing", () => {
  assert.deepEqual(splitFactKeyLine("/a/, /b{2,4}/, brass"), ["/a/", "/b{2,4}/", "brass"]);
  assert.deepEqual(splitFactKeyLine("/a{2,4}/, /oops, salt"), ["/a{2,4}/", "/oops", "salt"]);
  assert.deepEqual(parseFactKeys(["/😀/", "/a{2,4}/i"]), ["/😀/", "/a{2,4}/i"]);
  assert.deepEqual(parseFactKeys(["/home/user"]), ["/home/user"], "prose slash keys remain literal");
  const result = selectActiveFactsWithTrace([
    fact("/😀/"), fact("/[A-Z][a-z]+/"), fact("/[a-z]/i"), fact("/cat|dog/")
  ], context("😀 Brass, no animal."));
  assert.deepEqual(result.facts.map(({ id }) => id), ["fact-/😀/", "fact-/[A-Z][a-z]+/", "fact-/[a-z]/i"]);
  assert.equal(result.traces.get("fact-/😀/")?.kind, "regex");
});

test("regex quantifiers and character classes have bounded NFA semantics", () => {
  for (const [source, matching, nonMatching] of [
    ["a*b", "aaab", "c"],
    ["a+b", "aaab", "b"],
    ["a{2,}b", "aaab", "ab"],
    ["[a-]", "-", "b"]
  ] as const) {
    assert.equal(patternMatches(source, matching), true, `${source} matches ${matching}`);
    assert.equal(patternMatches(source, nonMatching), false, `${source} rejects ${nonMatching}`);
  }
  assert.throws(() => compileFactPattern("[z-a]", ""), /descending character range/);
  assert.throws(
    () => compileFactPattern("(?:a(?:b(?:c(?:d(?:e)))))", ""),
    /4-group nesting limit/
  );
  assert.equal(patternMatches("\\p{Lu}", "a", "i"), true);
});

test("always Facts seed recursion without an external context", () => {
  const facts: StoryFact[] = [
    { ...alwaysFact("seed"), id: "seed", text: "chain" },
    { ...fact("chain"), id: "chain", text: "leaf" },
    { ...fact("leaf"), id: "leaf" }
  ];
  const selected = selectActiveFactsWithTrace(facts);
  assert.deepEqual(selected.facts.map(({ id }) => id), ["seed", "chain", "leaf"]);
  assert.equal(selected.traces.get("chain")?.round, 1);
  assert.equal(selected.traces.get("leaf")?.round, 2);
});

test("regex matching reports work cut off by the shared step budget", () => {
  const facts = Array.from({ length: 50 }, (_, index) => ({
    ...fact(`/z${index}/`),
    id: `regex-${index}`,
    keys: ["/z/"]
  }));
  const result = selectActiveFactsWithTrace(facts, context("a".repeat(MAX_FACT_SCAN_UTF16)));
  assert.equal(result.facts.length, 0);
  assert.ok(result.unevaluated.length > 0);
  assert.ok(result.unevaluated.includes("regex-49"));
});

test("boundary-only regexes also use the shared operation budget", () => {
  const facts = Array.from({ length: 50 }, (_, index) => ({
    ...fact(`/\\b\\B${index}/`),
    id: `boundary-${index}`,
    keys: ["/\\b\\B/"]
  }));
  const result = selectActiveFactsWithTrace(facts, context("a".repeat(MAX_FACT_SCAN_UTF16)));
  assert.equal(result.facts.length, 0);
  assert.ok(result.unevaluated.length > 0);
});

test("an adversarial regex stays bounded across a full scan window", () => {
  const started = performance.now();
  const result = selectActiveFactsWithTrace(
    [fact("/(?:a|aa)*b/")],
    context("a".repeat(MAX_FACT_SCAN_UTF16))
  );
  assert.equal(result.facts.length, 0);
  assert.ok(performance.now() - started < 2_000);
});

test("regex word boundaries retain the scalar before a capped scan suffix", () => {
  const text = `xcat${" ".repeat(MAX_FACT_SCAN_UTF16 - 3)}`;
  assert.equal(selectActiveFactsWithTrace([fact("/\\bcat/")], context(text)).facts.length, 0);
});

test("secondary gates, scan depth, and recursion select Facts in stored order", () => {
  const facts: StoryFact[] = [
    { ...fact("hero"), id: "and", secondaryKeys: ["brass"], secondaryMode: "and" },
    { ...fact("hero"), id: "not", secondaryKeys: ["enemy"], secondaryMode: "not" },
    { ...fact("old"), id: "deep", recursion: "off" },
    { ...fact("old"), id: "shallow", scanDepth: 1 },
    { ...alwaysFact("seed"), id: "seed", text: "chain" },
    { ...fact("chain"), id: "chain", text: "leaf" },
    { ...fact("leaf"), id: "leaf" }
  ];
  const selected = selectActiveFactsWithTrace(facts, {
    contextParts: [part("one", "old"), part("two", "hero brass")], chapterBreaks: [], nodes: []
  });
  assert.deepEqual(selected.facts.map(({ id }) => id), ["and", "not", "deep", "seed", "chain", "leaf"]);
  assert.equal(selected.traces.get("chain")?.round, 1);
  assert.equal(selected.traces.get("leaf")?.round, 2);
});

// A per-fact fair share of the recursion window (shared/fact-scan.ts
// `recursionScanSegment`) only ever changes anything once the joined
// recursion text is over MAX_FACT_RECURSION_UTF16. Below that, this pins the
// unchanged case: several small always-active Facts all keep seeding the
// chain exactly as before.
test("recursion chain activation is unchanged when active Facts' text already fits the window", () => {
  const facts: StoryFact[] = [
    { ...alwaysFact("first"), id: "first", text: "The lantern keeper lit the wick." },
    { ...alwaysFact("second"), id: "second", text: "A storm gathered over the bay." },
    { ...fact("wick"), id: "chain-wick" },
    { ...fact("storm"), id: "chain-storm" }
  ];
  const selected = selectActiveFactsWithTrace(facts);
  assert.deepEqual(selected.facts.map(({ id }) => id), [
    "first", "second", "chain-wick", "chain-storm"
  ]);
  assert.equal(selected.traces.get("chain-wick")?.round, 1);
  assert.equal(selected.traces.get("chain-storm")?.round, 1);
});

// Before the fair-share fix, `recursionScanSegment` joined every active
// recursion-enabled Fact's *full* text and kept only the tail of the join.
// A single Fact bigger than the whole window — legal once MAX_FACT_TEXT_CHARS
// was raised — could then occupy the entire window by itself and silently
// erase every other active Fact's contribution to chain matching, even one
// listed ahead of it. This pins the fix: the small Fact's "teapot" survives
// and the chain Fact it feeds still activates.
test("a huge recursion-enabled Fact no longer crowds a small one out of the chain-activation window", () => {
  const small: StoryFact = { ...alwaysFact("small"), id: "small", text: "the small porcelain teapot sits here" };
  const big: StoryFact = { ...alwaysFact("big"), id: "big", text: "b".repeat(MAX_FACT_RECURSION_UTF16 * 2) };
  const chain: StoryFact = { ...fact("teapot"), id: "chain" };

  const selected = selectActiveFactsWithTrace([small, big, chain]);

  assert.deepEqual(
    new Set(selected.facts.map(({ id }) => id)),
    new Set(["small", "big", "chain"])
  );
  assert.equal(selected.traces.get("chain")?.round, 1);
});

function fact(key: string): StoryFact {
  return {
    id: `fact-${key}`,
    tag: null,
    text: `Fact for ${key}`,
    activation: "keyed",
    keys: [key],
    createdAt: NOW,
    updatedAt: NOW
  };
}

function alwaysFact(key: string): StoryFact {
  return { ...fact(key), activation: "always" };
}

function part(id: string, text: string): StoryNode {
  return {
    id,
    parentId: null,
    instruction: "Continue.",
    text,
    model: "test",
    createdAt: NOW,
    activeChildId: null
  };
}

function context(text: string): {
  contextParts: readonly StoryNode[];
  chapterBreaks: never[];
  nodes: never[];
} {
  return {
    contextParts: [part("part", text)],
    chapterBreaks: [],
    nodes: []
  };
}

function patternMatches(source: string, text: string, flags = ""): boolean {
  return factPatternMatches(
    compileFactPattern(source, flags),
    text,
    { steps: 1_000_000, exhausted: false }
  );
}
