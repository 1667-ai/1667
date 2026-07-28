import assert from "node:assert/strict";
import test from "node:test";
import { assertWithinBudget, cpuBudget, startTiming } from "./performance-budget.js";
import { activePath, childrenOf, pathTo, takeIndex } from "../shared/story-tree.js";
import { parseLegacyStory } from "../server/story-format.js";
import type { Tag, NodeStub, StoryPayload } from "../shared/types.js";
import {
  activeContinuationWindow,
  activePathWindow,
  tagBelow,
  continuationStats,
  createStoryIndex,
  mapForkPage,
  rememberedLeafId,
  subtreeNodeCount,
  virtualRange
} from "../shared/story-model.js";

const NOW = "2026-07-16T12:00:00.000Z";
const LINEAR_BUDGET = cpuBudget(1_500);

test("loom performance: a 20k-part line indexes and probes in linear time", (context) => {
  const size = 20_000;
  const nodes = Array.from({ length: size }, (_, index) => stub(
    `deep-${index}`,
    index === 0 ? null : `deep-${index - 1}`,
    index + 1 < size ? `deep-${index + 1}` : null,
    index + 1 < size ? 1 : 0
  ));
  const payload = story(nodes);
  const read = startTiming();
  assert.equal(activePath(payload).length, size);
  const index = createStoryIndex(payload);
  assert.equal(pathTo(index.tree, `deep-${size - 1}`).length, size);
  assert.equal(rememberedLeafId(payload, "deep-0", index), `deep-${size - 1}`);
  assert.deepEqual(continuationStats(payload, "deep-0", index), { parts: size - 1, words: size - 1 });
  const mapWindow = activeContinuationWindow(index, "deep-0");
  assert.equal(mapWindow.total, size - 1);
  assert.equal(mapWindow.head.length + mapWindow.tail.length, 25);
  assert.equal(mapWindow.hidden, size - 26);
  assert.equal(mapWindow.head[0]?.id, "deep-1");
  assert.equal(mapWindow.tail.at(-1)?.id, `deep-${size - 1}`);
  for (let offset = 0; offset < size; offset += 1) subtreeNodeCount(index, `deep-${offset}`);
  assert.ok(activePathWindow(size, 18).length < 50);
  const timing = read();

  assertWithinBudget(context, "20k deep index + full probes", LINEAR_BUDGET, timing);
});

test("loom performance: a 20k-take fork keeps previews and its DOM window bounded", (context) => {
  const takeCount = 20_000;
  const root = stub("wide-root", null, "wide-0", takeCount);
  const takes = Array.from({ length: takeCount }, (_, index) => stub(`wide-${index}`, root.id, null, 0));
  const tags: Tag[] = Array.from({ length: 100 }, (_, index) => ({
    nodeId: `wide-${index * 100}`,
    name: `Line ${index}`,
    status: "Alt",
    color: "#4b45c9",
    createdAt: NOW
  }));
  const payload = story([root, ...takes], tags);
  const read = startTiming();
  const index = createStoryIndex(payload);
  assert.equal(childrenOf(index.tree, root.id).length, takeCount);
  let ordinalChecksum = 0;
  for (const take of takes) {
    continuationStats(payload, take.id, index);
    tagBelow(payload, take.id, index);
    const ordinal = takeIndex(index.tree, take.id);
    if (ordinal.count !== takeCount) throw new Error(`Wrong sibling count for ${take.id}`);
    ordinalChecksum += ordinal.index;
  }
  const page = mapForkPage(payload, index, takes, `wide-${takeCount - 1}`, 50, 0);
  const timing = read();
  const middle = virtualRange(takeCount, 10_000 * 82, 82, 390, 3);
  const end = virtualRange(takeCount, takeCount * 82 - 390, 82, 390, 3);

  assert.equal(ordinalChecksum, takeCount * (takeCount + 1) / 2);
  assert.ok(middle.end - middle.start <= 11);
  assert.ok(end.end - end.start <= 11);
  assert.equal(end.end, takeCount);
  assert.deepEqual(page.rows.slice(0, 2).map((row) => [row.kind, row.index]), [
    ["take", 0], ["draft-rollup", 1]
  ]);
  assert.equal(page.rows.at(-1)?.index, takeCount - 1, "the active take remains visible outside the page");
  assert.ok(page.rows.length <= 52, "the map reconciles one page, one rollup, and the active take");
  assert.deepEqual(virtualRange(takeCount, Number.MAX_SAFE_INTEGER, 82, 390, 3), end);
  assertWithinBudget(context, "20k wide index + every-row metadata probe", LINEAR_BUDGET, timing);
});

test("loom performance: a mixed 10k-node loom precomputes nested rollups once", (context) => {
  const depth = 100;
  const alternatives = 99;
  const nodes: NodeStub[] = [];
  const tags: Tag[] = [];
  for (let level = 0; level < depth; level += 1) {
    nodes.push(stub(
      `trunk-${level}`,
      level === 0 ? null : `trunk-${level - 1}`,
      level + 1 < depth ? `trunk-${level + 1}` : null,
      alternatives + (level + 1 < depth ? 1 : 0)
    ));
    for (let take = 0; take < alternatives; take += 1) {
      const id = `alt-${level}-${take}`;
      nodes.push(stub(id, `trunk-${level}`, null, 0));
      if (take === 0) tags.push({
        nodeId: id,
        name: `Alt ${level}`,
        status: "Alt",
        color: "#4b45c9",
        createdAt: NOW
      });
    }
  }
  const payload = story(nodes, tags);
  const read = startTiming();
  const index = createStoryIndex(payload);
  for (const node of nodes) {
    continuationStats(payload, node.id, index);
    tagBelow(payload, node.id, index);
  }
  const timing = read();

  assert.equal(subtreeNodeCount(index, "trunk-0"), 10_000);
  assert.equal(rememberedLeafId(payload, "trunk-0", index), `trunk-${depth - 1}`);
  assertWithinBudget(context, "10k mixed index + every-node metadata probe", LINEAR_BUDGET, timing);
});

test("loom performance: a legacy 20k-part line migrates in linear time", (context) => {
  const size = 20_000;
  const raw = JSON.stringify({
    id: "legacy-performance", title: "Legacy performance", createdAt: NOW, updatedAt: NOW,
    parts: Array.from({ length: size }, (_, index) => ({
      id: `legacy-${index}`, instruction: "Continue", text: `Part ${index}`,
      model: "test", createdAt: NOW
    }))
  });
  const read = startTiming();
  const story = parseLegacyStory(raw, "legacy-performance");
  const timing = read();

  assert.equal(story.nodes.length, size);
  assert.equal(activePath(story).length, size);
  assertWithinBudget(context, "20k legacy migration", LINEAR_BUDGET, timing);
});

function stub(id: string, parentId: string | null, activeChildId: string | null, childCount: number): NodeStub {
  return {
    id,
    parentId,
    preview: `Preview ${id}`,
    words: 1,
    tokens: 1,
    childCount,
    leafCount: childCount === 0 ? 1 : childCount,
    lastTouched: NOW,
    hasInstruction: false,
    activeChildId
  };
}

function story(nodes: NodeStub[], tags: Tag[] = []): StoryPayload {
  return {
    id: "performance-fixture",
    title: "Performance fixture",
    createdAt: NOW,
    updatedAt: NOW,
    nodes,
    path: [],
    activeRootId: nodes.find((node) => node.parentId === null)?.id ?? null,
    tags,
    recentNodeIds: [],
    facts: [],
    chapterBreaks: []
  };
}
