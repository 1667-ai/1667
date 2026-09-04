import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFactConsistencyFindings,
  selectFactConsistencyParts
} from "../shared/fact-consistency.js";
import { factConsistencyPrompt } from "../shared/fact-consistency-prompt.js";
import {
  MAX_FACT_CONSISTENCY_RUN_BYTES,
  MAX_FACT_CONSISTENCY_FINDINGS_PER_PART,
  MAX_FACT_CONSISTENCY_ID_CHARS,
  MAX_FACT_CONSISTENCY_LINE_TAKES,
  MAX_FACT_CONSISTENCY_PARTS,
  hashFactConsistencyRun,
  parseFactConsistencyRun,
  serializeFactConsistencyRun,
  type FactConsistencyRun
} from "../shared/fact-consistency-types.js";
import { boundFactConsistencyRun } from "../server/story-service-fact-consistency.js";
import type { Story, StoryFact, StoryNode } from "../shared/types.js";

test("fact consistency selection follows unscoped, anchored, ended, and off-path states", () => {
  const story = fixture();
  const parts = selectFactConsistencyParts({
    story,
    focusedPartId: "root",
    scope: "story-line"
  });

  assert.deepEqual(parts.map((part) => part.partId), ["root", "child"]);
  assert.deepEqual(parts[0]!.facts.map((fact) => fact.factId), ["unscoped", "ended"]);
  assert.deepEqual(parts[1]!.facts.map((fact) => fact.factId), ["unscoped", "anchored"]);
  assert.equal(parts[1]!.facts.some((fact) => fact.factId === "ended"), false);
  assert.equal(parts.some((part) => part.facts.some((fact) => fact.factId === "off-path")), false);
});

test("fact consistency chapter scope starts at the focused chapter", () => {
  const story = fixture();
  story.chapterBreaks.push({
    id: "break",
    parentPartId: "root",
    title: "Second",
    createdAt: "2025-01-01T00:00:00.000Z"
  });
  const parts = selectFactConsistencyParts({
    story,
    focusedPartId: "child",
    scope: "chapter"
  });
  assert.deepEqual(parts.map((part) => part.partId), ["child"]);
  assert.deepEqual(parts[0]!.facts.map((fact) => fact.factId), ["unscoped", "anchored"]);
});

test("a scope with no applicable Fact State skips every part", () => {
  const story = fixture();
  story.facts = [story.facts.find((fact) => fact.id === "off-path")!];
  const parts = selectFactConsistencyParts({
    story,
    focusedPartId: "root",
    scope: "story-line"
  });
  assert.deepEqual(parts, []);
});

test("fact consistency parser accepts valid findings and counts rejected findings", () => {
  const part = selectFactConsistencyParts({
    story: fixture(),
    focusedPartId: "root",
    scope: "story-line"
  })[0]!;
  const marker = "[[fact-consistency-complete-test]]";
  const result = parseFactConsistencyFindings(
    [
      "**FACT:** 1",
      "**QUOTE:** \"Mira\"",
      "**STATEMENT:** The Fact holds blue eyes, but the prose says Mira.",
      "",
      "FACT: 99",
      "QUOTE: Mira",
      "STATEMENT: Unknown Fact.",
      "",
      "FACT: 1",
      "QUOTE:",
      "STATEMENT: Empty quote.",
      "",
      "FACT: 1",
      `QUOTE: ${part.text}`,
      "STATEMENT: Whole part.",
      "",
      "FACT: 1",
      "QUOTE: Mira was short",
      "STATEMENT: Not literal.",
      "",
      "FACT: 1",
      "QUOTE: Mira",
      "STATEMENT:",
      "",
      marker
    ].join("\n"),
    part.text,
    part.facts,
    marker
  );
  assert.equal(result.malformed, false);
  assert.deepEqual(result.findings, [{
    fact_id: "unscoped",
    quote: "Mira",
    statement: "The Fact holds blue eyes, but the prose says Mira."
  }]);
  assert.equal(result.droppedFindings, 5);
});

test("fact consistency parser rejects a response without its completion marker", () => {
  const part = selectFactConsistencyParts({
    story: fixture(),
    focusedPartId: "root",
    scope: "story-line"
  })[0]!;
  const result = parseFactConsistencyFindings(
    "FACT: 1\nQUOTE: Mira\nSTATEMENT: Contradiction.",
    part.text,
    part.facts,
    "[[fact-consistency-complete-test]]"
  );
  assert.equal(result.complete, false);
  assert.deepEqual(result.findings, []);
});

test("fact consistency parser enforces finding bytes while preserving provider order", () => {
  const part = selectFactConsistencyParts({
    story: fixture(),
    focusedPartId: "root",
    scope: "story-line"
  })[0]!;
  const marker = "[[fact-consistency-complete-budget]]";
  const result = parseFactConsistencyFindings(
    [
      "FACT: 1",
      "QUOTE: Mira",
      "STATEMENT: first",
      "",
      "FACT: 1",
      "QUOTE: Mira",
      "STATEMENT: second",
      "",
      marker
    ].join("\n"),
    part.text,
    part.facts,
    marker,
    { maxFindings: 8, maxBytes: 100 }
  );
  assert.deepEqual(result.findings.map((finding) => finding.statement), ["first"]);
  assert.equal(result.droppedFindings, 1);
  assert.equal(result.complete, true);
});

test("fact consistency prompt carries only one selected take and its applicable Facts", () => {
  const part = selectFactConsistencyParts({
    story: fixture(),
    focusedPartId: "root",
    scope: "story-line"
  })[0]!;
  const plan = factConsistencyPrompt(part);
  const text = plan.turns.flatMap((turn) => turn.blocks)
    .map((block) => block.kind === "image" ? "" : block.text)
    .join("\n");
  assert.equal(plan.operation, "fact-check");
  assert.match(text, /name: Eyes/u);
  assert.match(text, /tag: canon/u);
  assert.doesNotMatch(text, /id: unscoped/u);
  assert.match(text, /Blue eyes/u);
  assert.match(text, /Mira is tall\./u);
  for (const omitted of ["Author Brief", "Author's Note", "phrase bias", "banned strings", "Side Note"]) {
    assert.equal(text.includes(omitted), false, `prompt included ${omitted}`);
  }
});

test("fact consistency run serialization is bounded, deterministic, and hash-verifiable", () => {
  const run: FactConsistencyRun = {
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId: "run-1",
    scope: "story-line",
    anchor: { partId: "root", takeId: "root" },
    checkedAt: "2025-01-01T00:00:00.000Z",
    provider: { profile: "utility", preset: "custom", model: "test" },
    storyLineTakeIds: ["root", "child"],
    parts: [{
      partId: "root",
      takeId: "root",
      findings: [{ fact_id: "unscoped", quote: "Mira", statement: "Mismatch." }],
      droppedFindings: 2
    }],
    droppedFindings: 2
  };
  const first = serializeFactConsistencyRun(run);
  assert.equal(first, serializeFactConsistencyRun({ ...run }));
  const hash = hashFactConsistencyRun(run);
  assert.match(hash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(parseFactConsistencyRun(first, hash), run);
  assert.throws(() => parseFactConsistencyRun(`${first} `, hash), /hash mismatch/u);

  const canonicalLength = serializeFactConsistencyRun({
    ...run,
    runId: "r".repeat(MAX_FACT_CONSISTENCY_ID_CHARS)
  });
  assert.equal(
    parseFactConsistencyRun(canonicalLength).runId.length,
    MAX_FACT_CONSISTENCY_ID_CHARS
  );
  assert.throws(
    () => serializeFactConsistencyRun({
      ...run,
      runId: "r".repeat(MAX_FACT_CONSISTENCY_ID_CHARS + 1)
    }),
    /runId is invalid/u
  );
  const scalarRunId = "😀".repeat(MAX_FACT_CONSISTENCY_ID_CHARS);
  assert.equal(
    parseFactConsistencyRun(serializeFactConsistencyRun({ ...run, runId: scalarRunId })).runId,
    scalarRunId
  );
  assert.throws(
    () => serializeFactConsistencyRun({ ...run, runId: "\ud800" }),
    /runId is invalid/u
  );
});

test("fact consistency selection stays bounded for a 5,000-part line and 128 Facts", () => {
  const story = largeLineStory(MAX_FACT_CONSISTENCY_LINE_TAKES, 128);
  const parts = selectFactConsistencyParts({
    story,
    focusedPartId: "part-0",
    scope: "story-line"
  });

  assert.equal(parts.length, MAX_FACT_CONSISTENCY_LINE_TAKES);
  assert.equal(parts[0]!.facts.length, 128);
  assert.equal(parts.at(-1)!.facts.length, 128);
});

test("fact consistency accepts the supported 5,000-part line when it fits", () => {
  assert.equal(MAX_FACT_CONSISTENCY_LINE_TAKES, 5_000);
  assert.equal(MAX_FACT_CONSISTENCY_PARTS, 5_000);
  const ids = Array.from({ length: 5_000 }, (_, index) => `part-${index}`);
  const run: FactConsistencyRun = {
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId: "run-long-line",
    scope: "story-line",
    anchor: { partId: ids[0]!, takeId: ids[0]! },
    checkedAt: "2025-01-01T00:00:00.000Z",
    provider: { profile: "utility", preset: "custom", model: "test" },
    storyLineTakeIds: ids,
    parts: ids.map((id) => ({
      partId: id,
      takeId: id,
      findings: [],
      droppedFindings: 0
    })),
    droppedFindings: 0
  };

  const serialized = serializeFactConsistencyRun(run);
  assert.ok(Buffer.byteLength(serialized, "utf8") < MAX_FACT_CONSISTENCY_RUN_BYTES);
  assert.deepEqual(parseFactConsistencyRun(serialized), run);
});

test("Fact consistency drops verified findings that exceed the run object bound", () => {
  const findings = Array.from({ length: 24 }, (_, index) => ({
    fact_id: "unscoped",
    quote: `${index}${"M".repeat(89_999)}`,
    statement: "The Fact and prose differ."
  }));
  const bounded = boundFactConsistencyRun({
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId: "run-large",
    scope: "story-line",
    anchor: { partId: "root", takeId: "root" },
    checkedAt: "2025-01-01T00:00:00.000Z",
    provider: { profile: "utility", preset: "custom", model: "test" },
    storyLineTakeIds: ["root"],
    parts: [{
      partId: "root",
      takeId: "root",
      findings,
      droppedFindings: 0
    }],
    droppedFindings: 0
  });

  assert.ok(bounded.parts[0]!.findings.length < findings.length);
  assert.equal(bounded.droppedFindings, findings.length - bounded.parts[0]!.findings.length);
  assert.ok(Buffer.byteLength(serializeFactConsistencyRun(bounded), "utf8")
    <= MAX_FACT_CONSISTENCY_RUN_BYTES);
});

test("Fact consistency bounds findings per part after batch merging", () => {
  const findings = Array.from({
    length: MAX_FACT_CONSISTENCY_FINDINGS_PER_PART + 7
  }, (_, index) => ({
    fact_id: "unscoped",
    quote: `Mira ${index}`,
    statement: "The Fact and prose differ."
  }));
  const bounded = boundFactConsistencyRun({
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId: "run-per-part-bound",
    scope: "story-line",
    anchor: { partId: "root", takeId: "root" },
    checkedAt: "2025-01-01T00:00:00.000Z",
    provider: { profile: "utility", preset: "custom", model: "test" },
    storyLineTakeIds: ["root"],
    parts: [{
      partId: "root",
      takeId: "root",
      findings,
      droppedFindings: 3
    }],
    droppedFindings: 3
  });

  assert.equal(
    bounded.parts[0]!.findings.length,
    MAX_FACT_CONSISTENCY_FINDINGS_PER_PART
  );
  assert.equal(bounded.parts[0]!.droppedFindings, 10);
  assert.equal(bounded.droppedFindings, 10);
});

function fixture(): Story {
  const now = "2025-01-01T00:00:00.000Z";
  const root: StoryNode = {
    id: "root",
    parentId: null,
    instruction: "",
    text: "Mira is tall.",
    model: "human",
    createdAt: now,
    activeChildId: "child"
  };
  const child: StoryNode = {
    id: "child",
    parentId: "root",
    instruction: "",
    text: "Mira entered the room.",
    model: "human",
    createdAt: now,
    activeChildId: null
  };
  return {
    id: "story",
    title: "Test",
    createdAt: now,
    updatedAt: now,
    nodes: [root, child],
    activeRootId: "root",
    tags: [],
    recentNodeIds: [],
    facts: [
      fact("unscoped", "Blue eyes", undefined),
      fact("anchored", "Mira has a red coat", "child"),
      fact("ended", "Mira is alive", undefined, { anchorPartId: "child", ends: true }),
      fact("off-path", "The branch is dark", "branch")
    ],
    chapterBreaks: []
  };
}

function largeLineStory(partCount: number, factCount: number): Story {
  const now = "2025-01-01T00:00:00.000Z";
  const nodes: StoryNode[] = Array.from({ length: partCount }, (_, index) => ({
    id: `part-${index}`,
    parentId: index === 0 ? null : `part-${index - 1}`,
    instruction: "",
    text: `Mira entered room ${index}.`,
    model: "human",
    createdAt: now,
    activeChildId: index + 1 < partCount ? `part-${index + 1}` : null
  }));
  return {
    id: "large-story",
    title: "Large line",
    createdAt: now,
    updatedAt: now,
    nodes,
    activeRootId: "part-0",
    tags: [],
    recentNodeIds: [],
    facts: Array.from({ length: factCount }, (_, index) =>
      fact(`large-fact-${index}`, `Fact ${index}`, undefined)),
    chapterBreaks: []
  };
}

function fact(
  id: string,
  text: string,
  anchorPartId: string | undefined,
  end?: { readonly anchorPartId: string; readonly ends: true }
): StoryFact {
  const now = "2025-01-01T00:00:00.000Z";
  return {
    id,
    name: id === "unscoped" ? "Eyes" : undefined,
    tag: id === "unscoped" ? "canon" : null,
    states: end === undefined
      ? [{ id, ...(anchorPartId === undefined ? {} : { anchorPartId }), text, createdAt: now, updatedAt: now }]
      : [
          { id: `${id}-base`, text, createdAt: now, updatedAt: now },
          { id, anchorPartId: end.anchorPartId, ends: true, createdAt: now, updatedAt: now }
        ],
    activation: "always",
    keys: [],
    createdAt: now,
    updatedAt: now
  };
}
