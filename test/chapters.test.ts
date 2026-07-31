import assert from "node:assert/strict";
import test from "node:test";
import { assembleChapterContext, deriveChapters, isChapterSummaryStale } from "../shared/chapters.js";
import { parseWorkerMutation } from "../server/worker-mutations.js";
import { activePath, childrenOf, computeRollups, contextSlice, switchToNode, takeIndex } from "../shared/story-tree.js";
import type { ChapterBreak, StoryNode } from "../shared/types.js";
import { assertWithinBudget, cpuBudget, startTiming } from "./performance-budget.js";

const EARLY = "2026-01-01T00:00:00.000Z";
const MADE = "2026-01-02T00:00:00.000Z";
const LATE = "2026-01-03T00:00:00.000Z";

test("chapter derivation numbers extents and visibility follow each storyline", () => {
  const a = node("a", null, "b");
  const b = node("b", "a", "c");
  const c = node("c", "b", "e");
  const d = node("d", "b", "f");
  const e = node("e", "c");
  const f = node("f", "d");
  const shared = seam("shared", "a", "Shared opening");
  const leftOnly = seam("left", "c", "Left ending");
  const nodes = [a, b, c, d, e, f];

  const left = deriveChapters([a, b, c, e], [leftOnly, shared], nodes);
  assert.deepEqual(left.map((chapter) => ({
    number: chapter.number, title: chapter.title, extent: chapter.extent, closedBy: chapter.closedBy?.id ?? null
  })), [
    { number: 1, title: "", extent: { fromPartId: "a", toPartId: "a" }, closedBy: "shared" },
    { number: 2, title: "Shared opening", extent: { fromPartId: "b", toPartId: "c" }, closedBy: "left" },
    { number: 3, title: "Left ending", extent: { fromPartId: "e", toPartId: "e" }, closedBy: null }
  ]);
  const right = deriveChapters([a, b, d, f], [leftOnly, shared], nodes);
  assert.deepEqual(right.map((chapter) => [chapter.number, chapter.title, chapter.extent]), [
    [1, "", { fromPartId: "a", toPartId: "a" }],
    [2, "Shared opening", { fromPartId: "b", toPartId: "f" }]
  ]);
});

test("chapter summaries are dead-end metadata, not active-path takes", () => {
  const root = node("root", null, "summary");
  const prose = node("prose", "root");
  const summary = chapterSummary("summary", "root", "close", "root", "root");
  const story = {
    nodes: [root, prose, summary],
    activeRootId: root.id,
    recentNodeIds: []
  };
  assert.deepEqual(activePath(story).map((part) => part.id), [root.id]);
  assert.deepEqual(childrenOf(story, root.id).map((part) => part.id), [prose.id]);
  assert.deepEqual(takeIndex(story, prose.id), { index: 1, count: 1 });
  assert.throws(() => takeIndex(story, summary.id));
  assert.throws(() => switchToNode(story, summary.id));
  assert.deepEqual(computeRollups(story).get(root.id), {
    childCount: 1, leafCount: 1, lastTouched: EARLY
  });
});

test("chapter staleness follows edits and extent changes without stored state", () => {
  const p1 = node("p1", null, "p2");
  const p2 = node("p2", "p1", "p3");
  const p3 = node("p3", "p2", "p4");
  const p4 = node("p4", "p3");
  const closing = seam("close", "p3", "Next");
  const summary = chapterSummary("summary", "p3", closing.id, "p1", "p3");
  const nodes = [p1, p2, p3, p4, summary];
  let chapter = deriveChapters([p1, p2, p3, p4], [closing], nodes)[0]!;
  assert.equal(chapter.stale, false);
  p2.updatedAt = LATE;
  chapter = deriveChapters([p1, p2, p3, p4], [closing], nodes)[0]!;
  assert.equal(chapter.stale, true, "an edit inside the extent stales the summary");
  summary.madeAt = LATE;
  assert.equal(isChapterSummaryStale(summary, chapter.extent, chapter.parts), false, "refresh makes it fresh");

  const carved = seam("carved", "p1", "Middle");
  chapter = deriveChapters([p1, p2, p3, p4], [carved, closing], nodes)[1]!;
  assert.equal(chapter.summary?.id, summary.id);
  assert.equal(chapter.stale, true, "inserting a break changes the covered extent");
  chapter = deriveChapters([p1, p2, p3, p4], [closing], nodes)[0]!;
  assert.equal(chapter.stale, false, "removing the inserted break restores the covered extent");
});

test("chapter context preserves legacy output and mixes summarized and raw chapters", () => {
  const path = chain(5);
  assert.deepEqual(assembleChapterContext(path, [], path), contextSlice(path));

  const first = seam("first", "p2", "Two");
  const second = seam("second", "p4", "Three");
  const summary = chapterSummary("s1", "p2", first.id, "p1", "p2");
  summary.madeAt = EARLY;
  path[0]!.updatedAt = LATE;
  assert.deepEqual(
    assembleChapterContext(path, [first, second], [...path, summary]).map((part) => part.id),
    ["s1", "p3", "p4", "p5"],
    "stale summaries remain usable while an unsummarized prior chapter stays raw"
  );
});

test("legacy summary reset discards breaks above it and applies chapters below it", () => {
  const p1 = node("p1", null, "legacy");
  const legacy = { ...node("legacy", "p1", "p3"), role: "summary" as const };
  const p3 = node("p3", "legacy", "p4");
  const p4 = node("p4", "p3");
  const ignored = seam("ignored", "p1", "Old");
  const closing = seam("closing", "p3", "Current");
  const summary = chapterSummary("chapter-summary", "p3", closing.id, "legacy", "p3");
  assert.deepEqual(
    assembleChapterContext([p1, legacy, p3, p4], [ignored, closing], [p1, legacy, p3, p4, summary])
      .map((part) => part.id),
    ["chapter-summary", "p4"]
  );
});

test("chapter derivation and context assembly stay inside the platform budget", (context) => {
  const path = chain(5_000);
  const breaks: ChapterBreak[] = Array.from({ length: 40 }, (_, index) =>
    seam(`break-${index}`, `p${(index + 1) * 125}`, `Chapter ${index + 2}`));
  const read = startTiming();
  const chapters = deriveChapters(path, breaks, path);
  const assembled = assembleChapterContext(path, breaks, path);
  const timing = read();

  assert.equal(chapters.length, 41);
  assert.equal(assembled.length, path.length);
  assertWithinBudget(context, "5k chapter derivation + assembly", cpuBudget(50), timing);
});

function chain(count: number): StoryNode[] {
  return Array.from({ length: count }, (_, index) => node(
    `p${index + 1}`,
    index === 0 ? null : `p${index}`,
    index + 1 < count ? `p${index + 2}` : null
  ));
}

function node(id: string, parentId: string | null, activeChildId: string | null = null): StoryNode {
  return { id, parentId, instruction: "Continue", text: `Text ${id}`, model: "test", createdAt: EARLY, activeChildId };
}

function seam(id: string, parentPartId: string, title: string): ChapterBreak {
  return { id, parentPartId, title, createdAt: EARLY };
}

function chapterSummary(
  id: string,
  parentId: string,
  chapterBreakId: string,
  fromPartId: string,
  toPartId: string
): StoryNode {
  return {
    ...node(id, parentId),
    role: "summary",
    chapterBreakId,
    coveredExtent: { fromPartId, toPartId },
    madeAt: MADE,
    text: `Summary ${id}`
  };
}

test("chapter one takes its name from the story, because no break opens it", () => {
  const a = node("a", null, "b");
  const b = node("b", "a");
  const closing = seam("closing", "a", "Second");
  const nodes = [a, b];
  const path = activePath({ nodes, activeRootId: "a" } as never);

  // Every other chapter is named by the break that opens it. Chapter one has
  // no opening break, so an unnamed one has no title at all — which is what
  // lets the export omit a heading the document title already supplies.
  const unnamed = deriveChapters(path, [closing], nodes);
  assert.equal(unnamed[0]!.title, "");
  assert.equal(unnamed[1]!.title, "Second");

  const named = deriveChapters(path, [closing], nodes, "Arrival");
  assert.equal(named[0]!.title, "Arrival");
  assert.equal(named[1]!.title, "Second", "a later chapter still answers to its own break");

  // The seed reaches only chapter one; it is not a default for the rest.
  const noBreaks = deriveChapters(path, [], nodes, "Arrival");
  assert.equal(noBreaks.length, 1);
  assert.equal(noBreaks[0]!.title, "Arrival");
});

test("renaming a chapter accepts the null break of chapter one and an empty name", () => {
  // A null break id names chapter one, which no break opens.
  assert.deepEqual(
    parseWorkerMutation("renameChapterBreak", {
      storyId: "story", breakId: null, title: "Arrival"
    }),
    { storyId: "story", breakId: null, title: "Arrival" }
  );

  // Creating a break defaults its title to "", so rename has to be able to
  // reach the same state. Clearing chapter one's name restores the story's.
  assert.deepEqual(
    parseWorkerMutation("renameChapterBreak", {
      storyId: "story", breakId: null, title: ""
    }),
    { storyId: "story", breakId: null, title: "" }
  );
  assert.equal(
    parseWorkerMutation("renameChapterBreak", {
      storyId: "story", breakId: "break", title: ""
    }).title,
    ""
  );

  // A break id is still an identifier when one is given at all.
  assert.throws(() => parseWorkerMutation("renameChapterBreak", {
    storyId: "story", breakId: "", title: "Arrival"
  }), /breakId/u);
});
