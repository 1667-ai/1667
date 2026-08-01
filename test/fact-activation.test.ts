import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_FACT_SCAN_UTF16,
  selectActiveFacts
} from "../shared/fact-activation.js";
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
    const selected = selectActiveFacts(
      [fact(item.key)],
      context(item.text)
    );
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
  const selected = selectActiveFacts(facts, {
    contextParts: [
      part("one", "forgotten"),
      part("two", "alpha"),
      part("three", "recent"),
      part("four", "omega")
    ],
    chapterBreaks: [],
    nodes: [],
    instruction: "Use the instruction key now."
  });

  assert.deepEqual(selected.map(({ id }) => id), [
    "fact-standing",
    "fact-instruction key",
    "fact-alpha",
    "fact-recent"
  ]);
  assert.deepEqual(
    selectActiveFacts(facts).map(({ id }) => id),
    ["fact-standing"]
  );
});

test("the scan cap does not create a false word boundary", () => {
  const text = `xcat ${"z".repeat(MAX_FACT_SCAN_UTF16 - 4)}`;
  assert.equal(selectActiveFacts([fact("cat")], context(text)).length, 0);
  assert.equal(
    selectActiveFacts(
      [fact("a")],
      context(`z${" ".repeat(MAX_FACT_SCAN_UTF16)}`)
    ).length,
    0,
    "the omitted boundary scalar must not become searchable text"
  );
  assert.equal(
    selectActiveFacts(
      [fact("tail key")],
      context(`${"z".repeat(MAX_FACT_SCAN_UTF16)} tail key`)
    ).length,
    1
  );
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
