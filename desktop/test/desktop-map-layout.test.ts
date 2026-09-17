import assert from "node:assert/strict";
import test from "node:test";
import { computeMapLayout, DEFAULT_MAP_NODE_BUDGET } from "../renderer-map-layout.js";
import { computeMinimapGeometry, minimapPartIndexAtFraction } from "../renderer-minimap-layout.js";
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

test("a centerPartId option windows around the centre instead of the focused part", () => {
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
  const layout = computeMapLayout(fixture, "p10", { centerPartId: "p300" });
  assert.ok(layout.nodes.some((node) => node.id === "p300"), "the window should be centred on p300");
  assert.equal(layout.nodes.some((node) => node.id === "p10"), false, "the focused-but-not-centred part falls outside the window");
});

test("minimap geometry places chapter ticks and fork marks at the right fractions, and maps a fraction back to a part index", () => {
  // 4 parts, 10 words each: a chapter break right after p0, an off-path
  // sibling take ("alt") hanging off p1.
  const p0 = pathNode("p0", null, 10);
  const p1 = pathNode("p1", "p0", 10);
  const p2 = pathNode("p2", "p1", 10);
  const p3 = pathNode("p3", "p2", 10);
  const fixture = story({
    nodes: [
      stub("p0", null, 10, { childCount: 1 }),
      stub("p1", "p0", 10, { childCount: 2 }),
      stub("alt", "p1", 3, { childCount: 0 }),
      stub("p2", "p1", 10, { childCount: 1 }),
      stub("p3", "p2", 10, { childCount: 0 })
    ],
    path: [p0, p1, p2, p3],
    chapterBreaks: [{ id: "break-1", parentPartId: "p0", title: "Opening", createdAt: new Date().toISOString() }]
  });
  const geometry = computeMinimapGeometry(fixture);
  assert.equal(geometry.totalParts, 4);
  assert.equal(geometry.chapterTicks.length, 1);
  assert.equal(geometry.chapterTicks[0]!.fraction, 10 / 40, "the tick sits at the cumulative word boundary right after p0");
  assert.equal(geometry.forkFractions.length, 1, "only p1 has an off-path sibling");
  assert.equal(geometry.forkFractions[0]!, (10 + 20) / 2 / 40, "the mark sits at p1's midpoint");
  assert.equal(minimapPartIndexAtFraction(geometry, 0), 0);
  assert.equal(minimapPartIndexAtFraction(geometry, 0.99), 3);
  assert.equal(minimapPartIndexAtFraction(geometry, 10 / 40 + 0.01), 1, "just past the first boundary lands on p1");
});

test("minimap geometry counts an empty part as at least one word", () => {
  const p0 = pathNode("p0", null, 0);
  const p1 = pathNode("p1", "p0", 0);
  const fixture = story({ nodes: [stub("p0", null, 0), stub("p1", "p0", 0)], path: [p0, p1] });
  const geometry = computeMinimapGeometry(fixture);
  assert.deepEqual(geometry.cumulative, [0, 1, 2]);
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

// D-34 fisheye lens (Phase C2). `lensIndex` is a path index; the lens opens
// off-path branches whose subtree has more than one take instead of folding
// them to a run.

test("lensIndex opens an off-path chain of 4 takes that a plain layout collapses to one run", () => {
  const p1 = pathNode("p1", null, 5);
  const p2 = pathNode("p2", "p1", 5);
  const chainNodes: OrdinaryNodeStub[] = [];
  let parent = "p1";
  for (let index = 0; index < 4; index += 1) {
    const id = `b${index}`;
    chainNodes.push(stub(id, parent, 4, { childCount: index === 3 ? 0 : 1 }));
    parent = id;
  }
  const fixture = story({
    nodes: [stub("p1", null, 5, { childCount: 2 }), stub("p2", "p1", 5, { childCount: 0 }), ...chainNodes],
    path: [p1, p2]
  });

  const plain = computeMapLayout(fixture, "p2");
  assert.equal(plain.collapsedRuns.length, 1, "without lensIndex the chain folds to one run");
  assert.equal(plain.nodes.some((node) => node.id.startsWith("b")), false, "without lensIndex no chain member is drawn");
  assert.equal(plain.lens, null, "without lensIndex there is no lens");

  const lensed = computeMapLayout(fixture, "p2", { lensIndex: 0 });
  const chainDrawn = lensed.nodes.filter((node) => node.id.startsWith("b"));
  assert.equal(chainDrawn.length, 4, "the lens opens all 4 chain takes");
  assert.equal(lensed.collapsedRuns.some((run) => run.id === "run:b0"), false, "no run bar remains for the opened chain");
  assert.ok(lensed.lens !== null, "a lens rect is returned");

  const lastChain = chainDrawn.reduce((a, b) => (a.x > b.x ? a : b));
  const nextSpine = lensed.nodes.find((node) => node.id === "p2")!;
  assert.ok(nextSpine.x > lastChain.x + lastChain.r, `expected the next spine x (${nextSpine.x}) beyond the last opened node (${lastChain.x} + r ${lastChain.r})`);
});

test("a branch two forks outside the lens stays collapsed", () => {
  const nodes: OrdinaryNodeStub[] = [];
  const path: StoryPathNode[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 8; index += 1) {
    const id = `p${index}`;
    nodes.push(stub(id, parent, 3, { childCount: index === 7 ? 0 : 1 }));
    path.push(pathNode(id, parent, 3));
    parent = id;
  }
  nodes.push(stub("c0", "p0", 4, { childCount: 1 }));
  nodes.push(stub("c1", "c0", 4, { childCount: 0 }));
  nodes.push(stub("d0", "p6", 4, { childCount: 1 }));
  nodes.push(stub("d1", "d0", 4, { childCount: 0 }));
  const fixture = story({ nodes, path });

  const layout = computeMapLayout(fixture, "p7", { lensIndex: 0 });
  assert.ok(layout.nodes.some((node) => node.id === "c1"), "the near chain (at the lens centre) opens");
  assert.equal(layout.collapsedRuns.some((run) => run.id === "run:d0"), true, "the far chain (two forks away, past the max radius) stays collapsed");
  assert.equal(layout.nodes.some((node) => node.id === "d1"), false, "the far chain's members are not drawn individually");
});

test("an opened chain that forks again draws its chain plus one rest bar", () => {
  const p1 = pathNode("p1", null, 5);
  const p2 = pathNode("p2", "p1", 5);
  const fixture = story({
    nodes: [
      stub("p1", null, 5, { childCount: 2 }),
      stub("p2", "p1", 5, { childCount: 0 }),
      stub("b0", "p1", 4, { childCount: 1, activeChildId: "b1" }),
      stub("b1", "b0", 4, { childCount: 2, activeChildId: "b2" }),
      stub("b2", "b1", 4, { childCount: 0 }),
      stub("b1x", "b1", 3, { childCount: 0 })
    ],
    path: [p1, p2]
  });

  const layout = computeMapLayout(fixture, "p2", { lensIndex: 0 });
  for (const id of ["b0", "b1", "b2"]) assert.ok(layout.nodes.some((node) => node.id === id), `expected ${id} drawn individually`);
  assert.equal(layout.nodes.some((node) => node.id === "b1x"), false, "the fork's other branch is not drawn individually");
  const restRuns = layout.collapsedRuns.filter((run) => run.id === "run:b0");
  assert.equal(restRuns.length, 1, "exactly one rest bar for the branch that forks again");
  assert.equal(restRuns[0]!.count, 1, "the rest bar covers the one node off the chain");
  assert.equal(restRuns[0]!.tipNodeId, "b1x");
});

test("a windowed story with many deep off-path chains and a lens still stays within the ≤120 budget", () => {
  const nodes: OrdinaryNodeStub[] = [];
  const path: StoryPathNode[] = [];
  let parent: string | null = null;
  for (let index = 0; index < 400; index += 1) {
    const id = `p${index}`;
    nodes.push(stub(id, parent, 3, { childCount: index === 399 ? 0 : 1 }));
    path.push(pathNode(id, parent, 3));
    parent = id;
  }
  for (let offset = -10; offset <= 10; offset += 1) {
    const anchorIndex = 200 + offset;
    if (anchorIndex < 0 || anchorIndex >= 400) continue;
    let chainParent = `p${anchorIndex}`;
    for (let depth = 0; depth < 6; depth += 1) {
      const id = `p${anchorIndex}-alt${depth}`;
      nodes.push(stub(id, chainParent, 3, { childCount: depth === 5 ? 0 : 1 }));
      chainParent = id;
    }
  }
  const fixture = story({ nodes, path });

  const layout = computeMapLayout(fixture, "p200", { lensIndex: 200 });
  assert.ok(layout.nodes.length + layout.collapsedRuns.length <= DEFAULT_MAP_NODE_BUDGET, `expected <= ${DEFAULT_MAP_NODE_BUDGET}, got ${layout.nodes.length + layout.collapsedRuns.length}`);
  assert.equal(typeof layout.lens?.startIndex, "number", "a lens is present near the centre of the window");
  assert.ok(layout.nodes.some((node) => node.id.includes("-alt")), "at least one nearby off-path chain opened inside the lens");
  const withoutLens = computeMapLayout(fixture, "p200");
  assert.deepEqual([withoutLens.windowStart, withoutLens.windowEnd], [layout.windowStart, layout.windowEnd], "the lens does not change the drawn window");
});
