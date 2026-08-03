import assert from "node:assert/strict";
import test from "node:test";
import type { Story, StoryNode } from "../shared/types.js";
import { GenerationResultError } from "../server/errors.js";
import { sha256 } from "../server/story-format.js";
import { storyAutonameId } from "../server/story-metadata.js";
import { nodeRewriteId, setNodeRewriteId } from "../server/story-node-text.js";
import {
  applyProviderStoryEffect,
  chapterSourceFingerprint,
  type ProviderStoryEffect
} from "../server/story-provider-effect.js";
import { prepareProviderStoryEffect } from "../server/story-provider-preparation.js";

const AT = "2026-07-25T12:00:00.000Z";
const LATER = "2026-07-25T12:01:00.000Z";
const hydrate = async () => {};

function node(
  id: string,
  parentId: string | null,
  text: string,
  overrides: Partial<StoryNode> = {}
): StoryNode {
  return {
    id,
    parentId,
    instruction: "",
    text,
    model: "m",
    createdAt: AT,
    activeChildId: null,
    ...overrides
  };
}

function story(nodes: StoryNode[], activeRootId: string | null = "root"): Story {
  return {
    id: "st1",
    title: "T",
    createdAt: AT,
    updatedAt: AT,
    origin: {
      storyId: "origin-story",
      storyTitle: "Origin",
      partId: "origin-part",
      offset: null,
      createdAt: AT
    },
    nodes,
    activeRootId,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

test("provider effects are exhaustively operation-specific", () => {
  const effects = {
    autoname: {
      kind: "autoname",
      expectedTitle: "T",
      title: "Named"
    },
    continue: {
      kind: "continue",
      parentId: "root",
      appendTo: null,
      expectedTextHash: null,
      instruction: "Go",
      text: "Continuation.",
      model: "m",
      genId: "g",
      nodeId: "generated",
      expectedParentActiveChildId: null,
      expectedAppendActiveChildId: null,
      expectedActiveRootId: "root",
      expectedActiveLeafId: "root"
    },
    rewrite: {
      kind: "rewrite",
      nodeId: "root",
      expectedText: "Opening.",
      expectedInstruction: "",
      text: "Rewritten.",
      updatedAt: LATER
    },
    "summary-take": {
      kind: "summary-take",
      point: { nodeId: "root", offset: null },
      expected: null,
      sourceFingerprint: "x",
      summary: "Summary.",
      model: "m",
      instruction: "Summarize",
      commitIds: {}
    },
    "chapter-summary": {
      kind: "chapter-summary",
      breakId: "break",
      sourceFingerprint: "x",
      summary: "Summary.",
      model: "m"
    }
  } satisfies Record<ProviderStoryEffect["kind"], ProviderStoryEffect>;
  assert.equal(Object.keys(effects).length, 5);
});

test("provider effect preparation rejects an existing cancellation", () => {
  const cancelled = new AbortController();
  cancelled.abort();

  assert.throws(
    () => prepareProviderStoryEffect({
      kind: "continue",
      parentId: "root",
      appendTo: null,
      expectedTextHash: null,
      instruction: "Go",
      text: "Must not commit",
      model: "m",
      genId: "cancelled",
      expectedParentActiveChildId: null,
      expectedAppendActiveChildId: null,
      expectedActiveRootId: "root",
      expectedActiveLeafId: "root",
      cancelled: cancelled.signal
    }),
    (error: unknown) => error instanceof GenerationResultError
      && /Story writing was cancelled/.test(error.message)
  );
});

test("autoname changes only title metadata and rejects a concurrent rename", async () => {
  const current = story([node("root", null, "Opening.")]);
  current.facts = [{
    id: "fact",
    tag: null,
    text: "Keep",
    activation: "always",
    keys: [],
    createdAt: AT,
    updatedAt: AT
  }];
  await applyProviderStoryEffect(current, {
    kind: "autoname",
    expectedTitle: "T",
    title: "Model title",
    autonameId: "auto-1"
  }, hydrate);
  assert.equal(current.title, "Model title");
  assert.equal(storyAutonameId(current), "auto-1");
  assert.equal(current.origin?.storyId, "origin-story");
  assert.equal(current.facts[0]?.text, "Keep");

  await assert.rejects(
    applyProviderStoryEffect({ ...current, title: "Writer title" }, {
      kind: "autoname",
      expectedTitle: "T",
      title: "Lost"
    }, hydrate),
    GenerationResultError
  );
});

test("continue preserves concurrent writer state and does not steal its line", async () => {
  const current = story([
    node("root", null, "Opening.", { activeChildId: "human" }),
    node("human", "root", "Writer line.", { human: true })
  ]);
  current.tags = [{
    nodeId: "human",
    name: "Here",
    status: "",
    color: "blue",
    createdAt: AT
  }];
  current.recentNodeIds = ["human"];
  await applyProviderStoryEffect(current, {
    kind: "continue",
    parentId: "root",
    appendTo: null,
    expectedTextHash: null,
    instruction: "Continue",
    text: "Model line.",
    model: "m",
    genId: "g1",
    nodeId: "generated",
    expectedParentActiveChildId: null,
    expectedAppendActiveChildId: null,
    expectedActiveRootId: "root",
    expectedActiveLeafId: "root"
  }, hydrate);
  assert.deepEqual(current.nodes.map(({ id }) => id), [
    "root",
    "human",
    "generated"
  ]);
  assert.equal(current.nodes[0]?.activeChildId, "human");
  assert.equal(current.tags[0]?.nodeId, "human");
  assert.deepEqual(current.recentNodeIds, ["human"]);
  assert.equal(current.origin?.storyId, "origin-story");
});

test("continue preserves a writer extension below its requested parent", async () => {
  const current = story([
    node("root", null, "Opening.", { activeChildId: "child" }),
    node("child", "root", "Original ending.", { activeChildId: "extension" }),
    node("extension", "child", "Writer extension.", { human: true })
  ]);
  await applyProviderStoryEffect(current, {
    kind: "continue",
    parentId: "root",
    appendTo: null,
    expectedTextHash: null,
    instruction: "Retake",
    text: "Model alternative.",
    model: "m",
    genId: "g-deep-move",
    nodeId: "generated",
    expectedParentActiveChildId: "child",
    expectedAppendActiveChildId: null,
    expectedActiveRootId: "root",
    expectedActiveLeafId: "child"
  }, hydrate);

  assert.equal(current.activeRootId, "root");
  assert.equal(current.nodes[0]?.activeChildId, "child");
  assert.equal(current.nodes[1]?.activeChildId, "extension");
  assert.equal(current.nodes.at(-1)?.id, "generated");
});

test("continue deduplicates a Stop save with the same generation ID", async () => {
  const current = story([
    node("root", null, "Opening.", { activeChildId: "partial" }),
    node("partial", "root", "Partial.", { genId: "g1" })
  ]);
  const applied = await applyProviderStoryEffect(current, {
    kind: "continue",
    parentId: "root",
    appendTo: null,
    expectedTextHash: null,
    instruction: "Continue",
    text: "Completed.",
    model: "m",
    genId: "g1",
    nodeId: "completed",
    expectedParentActiveChildId: null,
    expectedAppendActiveChildId: null,
    expectedActiveRootId: "root",
    expectedActiveLeafId: "root"
  }, hydrate);
  assert.equal(applied.changed, false);
  assert.deepEqual(current.nodes.map(({ id }) => id), ["root", "partial"]);
});

test("append completion stays on its source after the writer switches lines", async () => {
  const current = story([
    node("source", null, "The latch was unlo"),
    node("writer", null, "A different line.", { human: true })
  ], "writer");
  await applyProviderStoryEffect(current, {
    kind: "continue",
    parentId: null,
    appendTo: "source",
    expectedTextHash: sha256("The latch was unlo"),
    instruction: "",
    text: "cked.",
    model: "m2",
    genId: "g-append",
    expectedParentActiveChildId: null,
    expectedAppendActiveChildId: null,
    expectedActiveRootId: "source",
    expectedActiveLeafId: "source"
  }, hydrate);
  assert.equal(current.nodes[0]?.text, "The latch was unlocked.");
  assert.equal(current.nodes[0]?.genId, "g-append");
  assert.equal(current.activeRootId, "writer");
  assert.equal(current.nodes.length, 2);
});

test("continue fails when its parent was deleted", async () => {
  await assert.rejects(
    applyProviderStoryEffect(story([node("root", null, "Opening.")]), {
      kind: "continue",
      parentId: "deleted",
      appendTo: null,
      expectedTextHash: null,
      instruction: "Continue",
      text: "Lost.",
      model: "m",
      genId: "g1",
      nodeId: "generated",
      expectedParentActiveChildId: null,
      expectedAppendActiveChildId: null,
      expectedActiveRootId: "root",
      expectedActiveLeafId: "root"
    }, hydrate),
    GenerationResultError
  );
});

test("late provider-effect cancellation is a definitive terminal conflict", async () => {
  const current = story([node("root", null, "Opening.")]);
  const cancelled = new AbortController();

  await assert.rejects(
    applyProviderStoryEffect(current, {
      kind: "continue",
      parentId: null,
      appendTo: "root",
      expectedTextHash: sha256("Opening."),
      instruction: "",
      text: " Must not commit.",
      model: "m",
      genId: "cancelled-after-hydration",
      expectedParentActiveChildId: null,
      expectedAppendActiveChildId: null,
      expectedActiveRootId: "root",
      expectedActiveLeafId: "root",
      cancelled: cancelled.signal
    }, async () => {
      cancelled.abort();
    }),
    (error: unknown) =>
      error instanceof GenerationResultError && error.code === "conflict"
  );
  assert.equal(current.nodes[0]?.text, "Opening.");
});

test("a chapter summary rewrite always replaces in place, even when a take is requested", async () => {
  const target = node("root", null, "Opening.", {
    attribution: { source: "human", ranges: [{ start: 0, end: 7 }] },
    human: true,
    genId: "original-gen",
    role: "summary",
    chapterBreakId: "break",
    coveredExtent: { fromPartId: "root", toPartId: "root" },
    madeAt: AT,
    editedByUser: true,
    activeChildId: "writer-child"
  });
  setNodeRewriteId(target, "old-rewrite");
  const current = story([target, node("writer-child", "root", "Writer.")]);
  await applyProviderStoryEffect(current, {
    kind: "rewrite",
    nodeId: "root",
    expectedText: "Opening.",
    expectedInstruction: "",
    text: "Model rewrite.",
    attribution: null,
    rewrittenSpans: [{ start: 0, end: 5 }],
    updatedAt: LATER,
    rewriteId: "rewrite-2",
    // A chapter summary cannot take a sibling — this proves the override
    // wins even when the caller asks for one.
    destination: "take"
  }, hydrate);
  assert.equal(target.text, "Model rewrite.");
  assert.equal(target.attribution, null);
  assert.deepEqual(target.rewrittenSpans, [{ start: 0, end: 5 }]);
  assert.equal(target.updatedAt, LATER);
  assert.equal(nodeRewriteId(target), "rewrite-2");
  assert.equal(target.activeChildId, "writer-child");
  assert.equal(target.instruction, "");
  assert.equal(target.genId, "original-gen");
  assert.equal(target.coveredExtent?.toPartId, "root");
  assert.equal(target.editedByUser, true);
  // A chapter summary is a dead end no take can branch from (`createTake`
  // refuses a chapter-summary parent); its rewrite keeps splicing in place
  // instead of minting a sibling.
  assert.equal(current.nodes.length, 2);
});

test("rewrite rejects instruction-only and timestamp-only concurrent edits", async () => {
  for (const changed of [
    node("root", null, "Opening.", { instruction: "Writer instruction" }),
    node("root", null, "Opening.", { updatedAt: LATER })
  ]) {
    await assert.rejects(
      applyProviderStoryEffect(story([changed]), {
        kind: "rewrite",
        nodeId: "root",
        expectedText: "Opening.",
        expectedInstruction: "",
        text: "Model rewrite.",
        updatedAt: LATER
      }, hydrate),
      GenerationResultError
    );
  }
});

test("rewrite of an ordinary take replaces in place by default and adds no node to the story line", async () => {
  const target = node("root", null, "Opening.", {
    attribution: { source: "human", ranges: [{ start: 0, end: 7 }] },
    human: true,
    genId: "original-gen",
    model: "writer-model",
    activeChildId: "writer-child"
  });
  const current = story([target, node("writer-child", "root", "Writer.")]);
  const applied = await applyProviderStoryEffect(current, {
    kind: "rewrite",
    nodeId: "root",
    expectedText: "Opening.",
    expectedInstruction: "",
    text: "Model rewrite.",
    attribution: null,
    rewrittenSpans: [{ start: 0, end: 5 }],
    updatedAt: LATER,
    rewriteId: "rewrite-2"
    // destination absent: in-place is the default.
  }, hydrate);

  assert.equal(applied.changed, true);
  // The target's own id comes back, not a new node's.
  assert.equal(applied.value.id, "root");
  assert.equal(applied.value.text, "Model rewrite.");
  assert.equal(applied.value.attribution, null);
  assert.deepEqual(applied.value.rewrittenSpans, [{ start: 0, end: 5 }]);
  assert.equal(nodeRewriteId(applied.value), "rewrite-2");
  // No sibling take: the story keeps exactly the two nodes it started with,
  // and the writer's continuation below the target is undisturbed.
  assert.equal(current.nodes.length, 2);
  assert.equal(target.activeChildId, "writer-child");
});

test("rewrite of an ordinary take opts into a new sibling and keeps the source reachable", async () => {
  const target = node("root", null, "Opening.", {
    attribution: { source: "human", ranges: [{ start: 0, end: 7 }] },
    human: true,
    genId: "original-gen",
    model: "writer-model",
    activeChildId: "writer-child"
  });
  const current = story([target, node("writer-child", "root", "Writer.")]);
  const applied = await applyProviderStoryEffect(current, {
    kind: "rewrite",
    nodeId: "root",
    expectedText: "Opening.",
    expectedInstruction: "",
    text: "Model rewrite.",
    attribution: null,
    updatedAt: LATER,
    rewriteId: "rewrite-2",
    takeId: "take-1",
    destination: "take"
  }, hydrate);

  assert.equal(applied.changed, true);
  assert.equal(applied.value.id, "take-1");
  assert.equal(applied.value.text, "Model rewrite.");
  assert.equal(applied.value.attribution, null);
  assert.equal(applied.value.parentId, null);
  // createEditedTake's field-carrying decisions, mirrored: model and human
  // travel from the source, generation identity deliberately does not.
  assert.equal(applied.value.model, "writer-model");
  assert.equal(applied.value.human, true);
  assert.equal(applied.value.genId, undefined);
  assert.equal(nodeRewriteId(applied.value), "rewrite-2");

  // The source survives untouched, reachable as a sibling of the new take.
  assert.equal(target.text, "Opening.");
  assert.equal(target.attribution?.source, "human");
  assert.equal(nodeRewriteId(target), undefined);
  assert.equal(current.nodes.length, 3);
  assert.equal(current.nodes.some((candidate) => candidate.id === "root"), true);
  // createTake's retarget rule: the new take wins the pointer.
  assert.equal(current.activeRootId, "take-1");
});

test("replaying a committed take-mode rewrite leaves the story unchanged", async () => {
  const target = node("root", null, "Opening.");
  const alreadyCommitted = node("take-1", null, "Model rewrite.");
  const current = story([target, alreadyCommitted], "take-1");
  const applied = await applyProviderStoryEffect(current, {
    kind: "rewrite",
    nodeId: "root",
    expectedText: "Opening.",
    expectedInstruction: "",
    text: "A different replay text — must not land.",
    updatedAt: LATER,
    rewriteId: "rewrite-2",
    takeId: "take-1",
    destination: "take"
  }, hydrate);

  assert.equal(applied.changed, false);
  assert.equal(applied.value.id, "take-1");
  assert.equal(applied.value.text, "Model rewrite.");
  assert.equal(current.nodes.length, 2);
  assert.equal(target.text, "Opening.");
});

test("replaying a committed in-place rewrite leaves the story unchanged", async () => {
  const target = node("root", null, "Model rewrite.");
  setNodeRewriteId(target, "rewrite-2");
  const current = story([target]);
  const applied = await applyProviderStoryEffect(current, {
    kind: "rewrite",
    nodeId: "root",
    // Deliberately stale: the marker must short-circuit before this is
    // ever checked, exactly like take mode's takeId presence does above.
    expectedText: "Opening.",
    expectedInstruction: "",
    text: "A different replay text — must not land.",
    updatedAt: LATER,
    rewriteId: "rewrite-2"
  }, hydrate);

  assert.equal(applied.changed, false);
  assert.equal(applied.value.id, "root");
  assert.equal(applied.value.text, "Model rewrite.");
  assert.equal(current.nodes.length, 1);
});

test("summary take validates current source and never changes navigation", async () => {
  const current = story([
    node("root", null, "Opening.", { activeChildId: "writer" }),
    node("writer", "root", "Writer line.")
  ]);
  const source = story([node("root", null, "Opening.")]);
  const sourceFingerprint = await import("../server/summary-take.js")
    .then(({ summarySourceFingerprint, summarizedPath }) =>
      summarySourceFingerprint(
        source.title,
        summarizedPath(source, { nodeId: "root", offset: null }, null),
        { nodeId: "root", offset: null }
      ));
  await applyProviderStoryEffect(current, {
    kind: "summary-take",
    point: { nodeId: "root", offset: null },
    expected: null,
    sourceFingerprint,
    summary: "Summary.",
    model: "m",
    instruction: "Summarize",
    commitIds: { summaryNodeId: "summary" }
  }, hydrate);
  assert.equal(current.nodes[0]?.activeChildId, "writer");
  assert.equal(current.nodes.find(({ id }) => id === "summary")?.role, "summary");
  await assert.rejects(
    applyProviderStoryEffect(story([], null), {
      kind: "summary-take",
      point: { nodeId: "root", offset: null },
      expected: null,
      sourceFingerprint,
      summary: "Summary.",
      model: "m",
      instruction: "Summarize",
      commitIds: { summaryNodeId: "deleted-summary" }
    }, hydrate),
    (error: unknown) =>
      error instanceof GenerationResultError && error.code === "conflict"
  );
});

test("chapter summary refresh preserves identity and transfers all summary metadata", async () => {
  const root = node("root", null, "Opening.", { activeChildId: "next" });
  const next = node("next", "root", "Next.", { activeChildId: "summary" });
  const summary = node("summary", "next", "Old summary.", {
    instruction: "Old",
    model: "old",
    role: "summary",
    chapterBreakId: "break",
    coveredExtent: { fromPartId: "root", toPartId: "next" },
    madeAt: AT,
    editedByUser: true
  });
  const current = story([root, next, summary]);
  current.chapterBreaks = [{
    id: "break",
    parentPartId: "next",
    title: "Chapter 1",
    createdAt: AT
  }];
  const sourceFingerprint = chapterSourceFingerprint(current, "break");
  await applyProviderStoryEffect(current, {
    kind: "chapter-summary",
    breakId: "break",
    sourceFingerprint,
    summary: "Fresh summary.",
    model: "new",
    rewriteId: "rewrite-summary"
  }, hydrate);
  assert.equal(summary.text, "Fresh summary.");
  assert.equal(summary.model, "new");
  assert.equal(summary.instruction.includes(current.title), true);
  assert.equal(summary.editedByUser, undefined);
  assert.equal(summary.attribution, undefined);
  assert.equal(nodeRewriteId(summary), "rewrite-summary");
  assert.equal(summary.coveredExtent?.toPartId, "next");
  assert.notEqual(summary.madeAt, AT);
});

test("chapter-source drift is a definitive terminal conflict", async () => {
  const current = story([node("root", null, "Opening.")]);

  await assert.rejects(
    applyProviderStoryEffect(current, {
      kind: "chapter-summary",
      breakId: "removed-break",
      sourceFingerprint: "provider-input",
      summary: "Must not commit.",
      model: "m"
    }, hydrate),
    (error: unknown) =>
      error instanceof GenerationResultError && error.code === "conflict"
  );
  assert.equal(current.nodes.length, 1);
});
