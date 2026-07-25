import assert from "node:assert/strict";
import test from "node:test";
import {
  captureStoryBaseline,
  deriveStoryDelta,
  rebaseStoryDelta
} from "../server/story-generation-rebase.js";
import { ProviderError } from "../server/errors.js";
import type { Story, StoryNode } from "../shared/types.js";

// The integration coverage for this lives in the loopback provider suites,
// which are Linux-only and therefore skip on a developer machine. The merge
// rules are pure, so they are tested directly and run everywhere.

const AT = "2026-07-25T12:00:00.000Z";

function node(id: string, parentId: string | null, text: string): StoryNode {
  return { id, parentId, instruction: "", text, model: "m", createdAt: AT, activeChildId: null };
}

function story(nodes: StoryNode[], activeRootId: string | null = "root"): Story {
  return {
    id: "st1",
    title: "T",
    createdAt: AT,
    updatedAt: AT,
    nodes,
    activeRootId,
    bookmarks: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

function clone(value: Story): Story {
  return structuredClone(value);
}

test("a line written while the model streamed survives the commit", () => {
  const base = story([node("root", null, "Opening.")]);
  const baseline = captureStoryBaseline(base);

  // The generation appends under root and puts itself on the line.
  const draft = clone(base);
  draft.nodes.push(node("gen", "root", "Model continuation."));
  draft.nodes[0]!.activeChildId = "gen";

  // Meanwhile the writer appends their own line and takes the line themselves.
  const current = clone(base);
  current.nodes.push(node("human", "root", "Written while it streamed."));
  current.nodes[0]!.activeChildId = "human";

  const merged = rebaseStoryDelta(current, deriveStoryDelta(baseline, draft));

  const ids = merged.nodes.map((entry) => entry.id);
  assert.deepEqual(ids, ["root", "human", "gen"]);
  assert.equal(
    merged.nodes.find((entry) => entry.id === "human")?.text,
    "Written while it streamed."
  );
  // The completion must not steal the line the writer extended.
  assert.equal(merged.nodes[0]!.activeChildId, "human");
});

test("an uncontended generation does take the line, or its output is invisible", () => {
  const base = story([node("root", null, "Opening.")]);
  const baseline = captureStoryBaseline(base);
  const draft = clone(base);
  draft.nodes.push(node("gen", "root", "Model continuation."));
  draft.nodes[0]!.activeChildId = "gen";

  const merged = rebaseStoryDelta(clone(base), deriveStoryDelta(baseline, draft));

  assert.equal(merged.nodes[0]!.activeChildId, "gen");
});

test("a rewrite keeps the writer's link rather than the one it read", () => {
  const base = story([node("root", null, "Opening."), node("a", "root", "A.")]);
  base.nodes[0]!.activeChildId = "a";
  const baseline = captureStoryBaseline(base);

  const draft = clone(base);
  draft.nodes[0]!.text = "Model rewrite.";

  const current = clone(base);
  current.nodes.push(node("b", "root", "Writer's take."));
  current.nodes[0]!.activeChildId = "b";

  const merged = rebaseStoryDelta(current, deriveStoryDelta(baseline, draft));

  assert.equal(merged.nodes[0]!.text, "Model rewrite.");
  assert.equal(merged.nodes[0]!.activeChildId, "b");
});

test("a generation never rewrites a node the writer edited underneath it", () => {
  const base = story([node("root", null, "Opening.")]);
  const baseline = captureStoryBaseline(base);

  const draft = clone(base);
  draft.nodes[0]!.text = "Model rewrite.";

  const current = clone(base);
  current.nodes[0]!.text = "Human edit.";

  assert.throws(
    () => rebaseStoryDelta(current, deriveStoryDelta(baseline, draft)),
    (error: unknown) => error instanceof ProviderError && /edited while the model/.test((error as Error).message)
  );
});

test("an unchanged node still accepts the rewrite", () => {
  const base = story([node("root", null, "Opening.")]);
  const baseline = captureStoryBaseline(base);
  const draft = clone(base);
  draft.nodes[0]!.text = "Model rewrite.";

  const merged = rebaseStoryDelta(clone(base), deriveStoryDelta(baseline, draft));

  assert.equal(merged.nodes[0]!.text, "Model rewrite.");
});

test("deleting the part a generation continued from fails it", () => {
  const base = story([node("root", null, "Opening."), node("mid", "root", "Middle.")]);
  const baseline = captureStoryBaseline(base);

  const draft = clone(base);
  draft.nodes.push(node("gen", "mid", "Continuation."));

  // The writer removes the parent while the model is still writing.
  const current = story([node("root", null, "Opening.")]);

  assert.throws(
    () => rebaseStoryDelta(current, deriveStoryDelta(baseline, draft)),
    (error: unknown) => error instanceof ProviderError && /removed while the model/.test((error as Error).message)
  );
});

test("a generation that adds a parent and its child keeps both", () => {
  const base = story([node("root", null, "Opening.")]);
  const baseline = captureStoryBaseline(base);
  const draft = clone(base);
  draft.nodes.push(node("summary", "root", "Recap."));
  draft.nodes.push(node("leaf", "summary", "After the recap."));

  const merged = rebaseStoryDelta(clone(base), deriveStoryDelta(baseline, draft));

  assert.deepEqual(merged.nodes.map((entry) => entry.id), ["root", "summary", "leaf"]);
});

test("the writer's chosen root outranks the generation's", () => {
  const base = story([node("root", null, "Opening.")], "root");
  const baseline = captureStoryBaseline(base);
  const draft = clone(base);
  draft.nodes.push(node("other", null, "Another beginning."));
  draft.activeRootId = "other";

  const current = clone(base);
  current.nodes.push(node("chosen", null, "Writer's beginning."));
  current.activeRootId = "chosen";

  const merged = rebaseStoryDelta(current, deriveStoryDelta(baseline, draft));

  assert.equal(merged.activeRootId, "chosen");
});

test("everything the generation did not touch comes from the current story", () => {
  const base = story([node("root", null, "Opening.")]);
  const baseline = captureStoryBaseline(base);
  const draft = clone(base);
  draft.nodes.push(node("gen", "root", "Continuation."));

  const current = clone(base);
  current.title = "Renamed while streaming";
  current.facts = [{ id: "f1", text: "A fact", createdAt: AT }] as Story["facts"];

  const merged = rebaseStoryDelta(current, deriveStoryDelta(baseline, draft));

  assert.equal(merged.title, "Renamed while streaming");
  assert.equal(merged.facts.length, 1);
});
