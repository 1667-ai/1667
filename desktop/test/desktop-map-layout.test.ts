import assert from "node:assert/strict";
import test from "node:test";
import { computeMapLayout, DEFAULT_MAP_NODE_BUDGET } from "../renderer-map-layout.js";
import type { OrdinaryNodeStub, StoryPathNode, StoryPayload } from "../../shared/types.js";

// No Electron here: `computeMapLayout` is a pure function of `story.nodes`/
// `story.path`, so it is checked directly. Every fixture node is an ordinary
// (non-chapter-summary) stub.

function stub(id: string, parentId: string | null, words: number, overrides: Partial<OrdinaryNodeStub> = {}): OrdinaryNodeStub {
  return {
    id,
    parentId,
    preview: `part ${id}`,
    words,
    tokens: words * 2,
    childCount: 0,
    leafCount: 1,
    lastTouched: new Date().toISOString(),
    hasInstruction: false,
    activeChildId: null,
    ...overrides
  };
}

function pathNode(id: string, parentId: string | null, words: number, overrides: Partial<StoryPathNode> = {}): StoryPathNode {
  return {
    id,
    parentId,
    instruction: "",
    text: "word ".repeat(words).trim(),
    model: "test",
    createdAt: new Date().toISOString(),
    activeChildId: null,
    ...overrides
  };
}

function story(overrides: Partial<StoryPayload> = {}): StoryPayload {
  return {
    id: "story-1",
    title: "Story",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
    path: [],
    activeRootId: null,
    tags: [],
    recentNodeIds: [],
    facts: [],
    chapterBreaks: [],
    ...overrides
  };
}

test("a retake with a tagged alternate draws the spine plus the off-path take", () => {
  const p1 = pathNode("p1", null, 5);
  const take1 = pathNode("take1", "p1", 6);
  const take2 = stub("take2", "p1", 4);
  const fixture = story({
    nodes: [stub("p1", null, 5, { childCount: 1 }), stub("take1", "p1", 6, { childCount: 0 }), take2],
    path: [p1, take1]
  });
  const layout = computeMapLayout(fixture, "take1");
  assert.ok(layout.nodes.length >= 3, `expected >= 3 nodes, got ${layout.nodes.length}`);
  const onPath = layout.nodes.filter((node) => node.onPath);
  const offPath = layout.nodes.filter((node) => !node.onPath);
  assert.equal(onPath.length, 2);
  assert.equal(offPath.length, 1);
  assert.equal(offPath[0]!.id, "take2");
  assert.equal(layout.collapsedRuns.length, 0, "a single off-path node does not collapse to a run");
});

test("a dead-end off-path take draws small and faint-flagged", () => {
  const p1 = pathNode("p1", null, 5);
  const fixture = story({
    nodes: [stub("p1", null, 5, { childCount: 1 }), stub("shown", "p1", 6), stub("dead", "p1", 0, { childCount: 0 })],
    path: [p1, pathNode("shown", "p1", 6)]
  });
  const layout = computeMapLayout(fixture, "shown");
  const dead = layout.nodes.find((node) => node.id === "dead");
  assert.ok(dead !== undefined);
  assert.equal(dead!.deadEnd, true);
  assert.equal(dead!.r, 5);
});

test("a long forkless run off the path collapses to one bar", () => {
  const nodes: OrdinaryNodeStub[] = [stub("p1", null, 5, { childCount: 1 })];
  let parent = "p1";
  for (let index = 0; index < 12; index += 1) {
    const id = `run${index}`;
    nodes.push(stub(id, parent, 3, { childCount: 1 }));
    parent = id;
  }
  nodes[nodes.length - 1] = { ...nodes[nodes.length - 1]!, childCount: 0 };
  nodes.push(stub("shown", "p1", 6, { childCount: 0 }));
  const fixture = story({ nodes, path: [pathNode("p1", null, 5), pathNode("shown", "p1", 6)] });
  const layout = computeMapLayout(fixture, "shown");
  assert.equal(layout.collapsedRuns.length, 1);
  assert.equal(layout.collapsedRuns[0]!.count, 12);
  assert.equal(layout.nodes.some((node) => node.id.startsWith("run")), false, "run members are not drawn individually");
});

test("a fork with many sibling takes caps its drawn branches and folds the rest", () => {
  const nodes: OrdinaryNodeStub[] = [stub("p1", null, 5, { childCount: 20 })];
  for (let index = 0; index < 20; index += 1) nodes.push(stub(`sib${index}`, "p1", 2, { childCount: 0 }));
  const fixture = story({ nodes, path: [pathNode("p1", null, 5), pathNode("sib0", "p1", 2)] });
  const layout = computeMapLayout(fixture, "sib0");
  const offPathNodes = layout.nodes.filter((node) => !node.onPath);
  const overflowRuns = layout.collapsedRuns.filter((run) => run.id.startsWith("run:overflow:"));
  assert.equal(overflowRuns.length, 1, "the 19 remaining siblings fold into one overflow bar");
  assert.ok(offPathNodes.length <= 8, `expected at most 8 individually drawn siblings, got ${offPathNodes.length}`);
  assert.equal(offPathNodes.length + overflowRuns[0]!.count, 19, "every hidden sibling is still counted");
});

test("a fork with 5 off-path siblings gets 5 distinct rows (review-fixes-2 finding 11)", () => {
  // 6 children of p1: sib0 is the shown (on-path) take, sib1..sib5 are the
  // 5 off-path branches whose rows must not collide (the old 3-row cycle
  // put sib1 and sib4 at the exact same position).
  const nodes: OrdinaryNodeStub[] = [stub("p1", null, 5, { childCount: 6 })];
  for (let index = 0; index < 6; index += 1) nodes.push(stub(`sib${index}`, "p1", 2, { childCount: 0 }));
  const fixture = story({ nodes, path: [pathNode("p1", null, 5), pathNode("sib0", "p1", 2)] });
  const layout = computeMapLayout(fixture, "sib0");
  const offPathNodes = layout.nodes.filter((node) => !node.onPath);
  assert.equal(offPathNodes.length, 5, "sib1..sib5 are the off-path branches");
  const ys = new Set(offPathNodes.map((node) => node.y));
  assert.equal(ys.size, 5, `expected 5 distinct y positions, got ${ys.size}`);
});

test("two root takes both appear in the layout (review finding 12)", () => {
  const p1 = pathNode("p1", null, 5);
  const fixture = story({
    nodes: [stub("p1", null, 5, { childCount: 0 }), stub("alt-root", null, 4, { childCount: 0 })],
    path: [p1]
  });
  const layout = computeMapLayout(fixture, "p1");
  const offPath = layout.nodes.filter((node) => !node.onPath);
  assert.equal(offPath.length, 1, "the alternate root take should still be collected as a branch");
  assert.equal(offPath[0]?.id, "alt-root");
});

test("the budget windows the spine and folds the rest into boundary bars", () => {
  const nodes: OrdinaryNodeStub[] = [];
  const path: StoryPathNode[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 400; index += 1) {
    const id = `p${index}`;
    nodes.push(stub(id, parent, 3, { childCount: index === 399 ? 0 : 1 }));
    path.push(pathNode(id, parent, 3));
    parent = id;
  }
  const fixture = story({ nodes, path });
  const layout = computeMapLayout(fixture, "p200");
  assert.ok(layout.nodes.length + layout.collapsedRuns.length <= DEFAULT_MAP_NODE_BUDGET, "the ≤120 invariant");
  assert.equal(layout.windowed, true);
  assert.ok(layout.windowStart > 0 && layout.windowEnd < path.length);
});

test("layout runs comfortably fast for a 2 000-node synthetic story", () => {
  const nodes: OrdinaryNodeStub[] = [];
  const path: StoryPathNode[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 2000; index += 1) {
    const id = `p${index}`;
    nodes.push(stub(id, parent, 4 + (index % 7), { childCount: index === 1999 ? 0 : 1 }));
    path.push(pathNode(id, parent, 4 + (index % 7)));
    if (index % 37 === 0 && index > 0) {
      // A short off-path branch every so often, like an abandoned take.
      nodes.push(stub(`${id}-alt`, path[index - 1]!.id, 5, { childCount: 0 }));
    }
    parent = id;
  }
  const fixture = story({ nodes, path });
  const start = performance.now();
  const layout = computeMapLayout(fixture, "p1000");
  const elapsedMs = performance.now() - start;
  assert.ok(layout.nodes.length + layout.collapsedRuns.length <= DEFAULT_MAP_NODE_BUDGET);
  // Budget is 16ms; a generous 50ms ceiling catches a real O(n^2) regression
  // without making the test flaky on a loaded CI box. See the phase report
  // for the measured time against the 16ms target.
  assert.ok(elapsedMs < 50, `layout took ${elapsedMs.toFixed(2)}ms, expected well under 50ms`);
  // eslint-disable-next-line no-console -- the exact figure belongs in the report, not just pass/fail.
  console.log(`computeMapLayout: 2 000 nodes in ${elapsedMs.toFixed(3)}ms`);
});
