import assert from "node:assert/strict";
import test from "node:test";
import type { NodeStub, StoryNode, StoryPayload } from "../shared/types.js";
import {
  activePathWindow,
  bookmarkBelow,
  continuationStats,
  deletionCopy,
  recentLeafIds,
  rememberedLineBookmark,
  summaryExtendsCurrentLeaf,
  summaryLockedNodeIds,
  summaryPruneLockedNodeIds,
  switchAnnouncement
} from "../shared/loom-model.js";

const NOW = "2026-07-16T12:00:00.000Z";

function stub(
  id: string,
  parentId: string | null,
  activeChildId: string | null,
  words: number,
  childCount = 0
): NodeStub {
  return {
    id,
    parentId,
    preview: `Preview ${id}`,
    words,
    tokens: words,
    childCount,
    leafCount: childCount === 0 ? 1 : childCount,
    lastTouched: NOW,
    hasInstruction: false,
    activeChildId
  };
}

function node(source: NodeStub): StoryNode {
  return {
    id: source.id,
    parentId: source.parentId,
    instruction: "",
    text: source.preview,
    model: "dry-run",
    createdAt: NOW,
    activeChildId: source.activeChildId
  };
}

function payload(nodes: NodeStub[], pathIds: string[]): StoryPayload {
  return {
    id: "story",
    title: "Test",
    createdAt: NOW,
    updatedAt: NOW,
    nodes,
    path: pathIds.map((id) => node(nodes.find((candidate) => candidate.id === id)!)),
    activeRootId: pathIds[0] ?? null,
    bookmarks: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}

test("loom previews count only the remembered line, not every node in the subtree", () => {
  const story = payload([
    stub("root", null, "take-a", 2, 2),
    stub("take-a", "root", "a-next", 3, 2),
    stub("a-next", "take-a", null, 5),
    stub("a-unused", "take-a", null, 99),
    stub("take-b", "root", null, 7)
  ], ["root", "take-a", "a-next"]);

  assert.deepEqual(continuationStats(story, "take-a"), { parts: 1, words: 5 });
  assert.deepEqual(continuationStats(story, "take-b"), { parts: 0, words: 0 });
});

test("switch feedback reports parts after the chosen take and the terminal part number", () => {
  const nodes = [
    stub("root", null, "take-a", 2, 1),
    stub("take-a", "root", "a-next", 3, 1),
    stub("a-next", "take-a", null, 5)
  ];
  const continuing = payload(nodes, ["root", "take-a", "a-next"]);
  continuing.bookmarks.push({
    nodeId: "a-next",
    name: "Lantern road",
    label: "Alt",
    color: "#4b45c9",
    createdAt: NOW
  });

  assert.equal(switchAnnouncement(continuing, "take-a"), "Now on: Lantern road — 1 part follows.");

  const ending = payload(nodes.map((candidate) => ({
    ...candidate,
    activeChildId: candidate.id === "take-a" ? null : candidate.activeChildId
  })), ["root", "take-a"]);
  assert.equal(switchAnnouncement(ending, "take-a"), "Now on: Preview take-a… — the story ends after Part 2.");
});

test("delete confirmation always states the exact affected part count", () => {
  assert.equal(deletionCopy(1), "Delete this take? 1 part total, gone for good.");
  assert.equal(deletionCopy(4), "Delete this take and the 3 parts beneath it? 4 parts total, gone for good.");
});

test("recent lines resolve remembered descendants without repeating the active line", () => {
  const story = payload([
    stub("old-endpoint", null, "current-leaf", 2, 1),
    stub("current-leaf", "old-endpoint", null, 3),
    stub("other-leaf", null, null, 4)
  ], ["old-endpoint", "current-leaf"]);
  story.recentNodeIds = ["old-endpoint", "current-leaf", "other-leaf", "other-leaf"];

  assert.deepEqual(recentLeafIds(story, "current-leaf"), ["other-leaf"]);
});

test("line rows ignore bookmarks on unrelated inactive descendants", () => {
  const story = payload([
    stub("take", null, "remembered", 1, 2),
    stub("remembered", "take", null, 1),
    stub("inactive", "take", null, 1)
  ], ["take", "remembered"]);
  story.bookmarks.push({
    nodeId: "inactive", name: "Other canon", label: "Canon", color: "#123", createdAt: NOW
  });

  assert.equal(rememberedLineBookmark(story, "take"), null);
  assert.equal(bookmarkBelow(story, "take")?.name, "Other canon", "subtree visibility still sees the bookmark");
  // Payloads are immutable adoption units — a bookmark change arrives as a new
  // payload, and the memoized loom index is keyed on that identity.
  const renamed = payload([
    stub("take", null, "remembered", 1, 2),
    stub("remembered", "take", null, 1),
    stub("inactive", "take", null, 1)
  ], ["take", "remembered"]);
  renamed.bookmarks.push({
    nodeId: "remembered", name: "Reading", label: "Alt", color: "#456", createdAt: NOW
  });
  assert.equal(rememberedLineBookmark(renamed, "take")?.name, "Reading");
});

test("very deep active paths keep a bounded initial DOM window", () => {
  const initial = activePathWindow(20_000, 18);
  assert.equal(initial.length, 34);
  assert.deepEqual(initial.slice(0, 4), [0, 1, 2, 3]);
  assert.deepEqual(initial.slice(-3), [19_997, 19_998, 19_999]);

  const expanded = activePathWindow(20_000, 68);
  assert.equal(expanded.length, 84);
  assert.equal(expanded[4], 19_920);
  assert.deepEqual(activePathWindow(30, 18), Array.from({ length: 30 }, (_, index) => index));
});

test("summary locks start at the latest context reset", () => {
  const before = stub("before", null, "summary", 1, 1);
  const summary = { ...stub("summary", "before", "target", 1, 1), role: "summary" as const };
  const target = stub("target", "summary", null, 1);
  const story = payload([before, summary, target], [before.id, summary.id, target.id]);

  assert.deepEqual(
    [...summaryLockedNodeIds({ storyId: story.id, nodeId: target.id, offset: null }, story)],
    [summary.id, target.id]
  );
  assert.deepEqual(
    [...summaryPruneLockedNodeIds({ storyId: story.id, nodeId: target.id, offset: null }, story)],
    [before.id, summary.id, target.id],
    "pruning an ancestor would still remove the fingerprinted source"
  );
});

test("selection summaries remain undoable even when they cut the current leaf", () => {
  const whole = { storyId: "story", nodeId: "leaf", offset: null };
  assert.equal(summaryExtendsCurrentLeaf(whole, "leaf"), true);
  assert.equal(summaryExtendsCurrentLeaf({ ...whole, offset: 5 }, "leaf"), false);
  assert.equal(summaryExtendsCurrentLeaf(whole, "older-leaf"), false);
});
