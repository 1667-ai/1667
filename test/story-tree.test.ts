import assert from "node:assert/strict";
import test from "node:test";
import {
  activeLeafId,
  activePath,
  childrenOf,
  computeRollups,
  contextSlice,
  hasFork,

  leafCount,
  nodeById,
  pathTo,
  subtreeCount,
  subtreeIds,
  switchToNode,
  takeIndex,
  unusedTakePruneSelection,
  type LineState,
  type TreeState
} from "../shared/story-tree.js";
import type { StoryNode } from "../shared/types.js";

test("story tree: children and take indexes preserve document order across 31 siblings", () => {
  const parent = node("parent");
  const siblings = Array.from({ length: 31 }, (_, index) => node(`take-${index + 1}`, parent.id));
  const state = tree([parent, ...siblings], parent.id);

  assert.deepEqual(
    childrenOf(state, parent.id).map(({ id }) => id),
    siblings.map(({ id }) => id)
  );
  assert.deepEqual(takeIndex(state, "take-17"), { index: 17, count: 31 });
  assert.strictEqual(nodeById(state, "take-17"), siblings[16]);
  assert.equal(nodeById(state, "missing"), null);
});

test("story tree: active path handles empty and linear stories", () => {
  assert.deepEqual(activePath(tree([], null)), []);
  assert.equal(activeLeafId(tree([], null)), null);

  const root = node("root", null, "middle");
  const middle = node("middle", root.id, "leaf");
  const leaf = node("leaf", middle.id);
  const state = tree([root, middle, leaf], root.id);

  assert.deepEqual(activePath(state), [root, middle, leaf]);
  assert.equal(activeLeafId(state), leaf.id);
});

test("story tree: active path follows the selected take through a mid-tree fork", () => {
  const root = node("root", null, "trunk");
  const trunk = node("trunk", root.id, "right");
  const left = node("left", trunk.id, "left-leaf");
  const right = node("right", trunk.id, "right-leaf");
  const leftLeaf = node("left-leaf", left.id);
  const rightLeaf = node("right-leaf", right.id);
  const state = tree([root, trunk, left, right, leftLeaf, rightLeaf], root.id);

  assert.deepEqual(activePath(state).map(({ id }) => id), ["root", "trunk", "right", "right-leaf"]);
});

test("story tree: active path stops at dangling child pointers without throwing", () => {
  const missing = node("missing-pointer", null, "absent");
  assert.deepEqual(activePath(tree([missing], missing.id)), [missing]);

  const nonChild = node("non-child-pointer", null, "other-root");
  const otherRoot = node("other-root");
  assert.deepEqual(activePath(tree([nonChild, otherRoot], nonChild.id)), [nonChild]);
});

test("story tree: active path ends where an active child pointer is null", () => {
  const root = node("root", null, "middle");
  const middle = node("middle", root.id);
  const unusedChild = node("unused-child", middle.id);

  assert.deepEqual(activePath(tree([root, middle, unusedChild], root.id)), [root, middle]);
});

test("story tree: paths, ancestry, and subtrees resolve a three-level tree", () => {
  const root = node("root");
  const left = node("left", root.id);
  const right = node("right", root.id);
  const leftA = node("left-a", left.id);
  const leftB = node("left-b", left.id);
  const rightA = node("right-a", right.id);
  const state = tree([root, left, right, leftA, leftB, rightA], root.id);

  assert.deepEqual(pathTo(state, leftB.id), [root, left, leftB]);
  assert.throws(() => pathTo(state, "missing"), new Error("Unknown node: missing"));
  assert.deepEqual(subtreeIds(state, left.id), [left.id, leftA.id, leftB.id]);
  assert.deepEqual(subtreeIds(state, root.id), state.nodes.map(({ id }) => id));
  assert.equal(subtreeCount(state, left.id), 3);
  assert.equal(subtreeCount(state, rightA.id), 1);
  assert.equal(hasFork(state), true);
  assert.equal(leafCount(state), 3);
  assert.equal(hasFork(tree([root], root.id)), false);
  assert.equal(leafCount(tree([], null)), 0);
});

test("story tree: rollups count children and leaves and keep the latest subtree touch", () => {
  const root = node("root", null, null, { createdAt: at(1) });
  const left = node("left", root.id, null, { createdAt: at(2) });
  const right = node("right", root.id, null, { createdAt: at(4), updatedAt: at(9) });
  const leftLeaf = node("left-leaf", left.id, null, { createdAt: at(3), updatedAt: at(7) });
  const rightLeafA = node("right-leaf-a", right.id, null, { createdAt: at(5) });
  const rightLeafB = node("right-leaf-b", right.id, null, { createdAt: at(8) });
  const rollups = computeRollups(tree([root, left, right, leftLeaf, rightLeafA, rightLeafB], root.id));

  assert.deepEqual(rollups.get(root.id), { childCount: 2, leafCount: 3, lastTouched: at(9) });
  assert.deepEqual(rollups.get(left.id), { childCount: 1, leafCount: 1, lastTouched: at(7) });
  assert.deepEqual(rollups.get(right.id), { childCount: 2, leafCount: 2, lastTouched: at(9) });
  assert.deepEqual(rollups.get(leftLeaf.id), { childCount: 0, leafCount: 1, lastTouched: at(7) });
});

test("story tree: context starts at the last summary node", () => {
  const first = node("first");
  const firstSummary = node("first-summary", first.id, null, { role: "summary" });
  const middle = node("middle", firstSummary.id);
  const lastSummary = node("last-summary", middle.id, null, { role: "summary" });
  const last = node("last", lastSummary.id);

  assert.deepEqual(contextSlice([first, middle, last]), [first, middle, last]);
  assert.deepEqual(contextSlice([first, firstSummary, middle]), [firstSummary, middle]);
  assert.deepEqual(contextSlice([first, firstSummary, middle, lastSummary, last]), [lastSummary, last]);
});

test("story tree: unused-take pruning keeps continuations, named lines, single takes, and one leaf per fork", () => {
  const root = node("root", null, "continued");
  const continued = node("continued", root.id, "continued-child");
  const continuedChild = node("continued-child", continued.id);
  const leafA = node("leaf-a", root.id);
  const leafB = node("leaf-b", root.id);
  const namedLeaf = node("named-leaf", root.id);
  const onlyLeafParent = node("only-leaf-parent", continuedChild.id, "deep");
  const deep = node("deep", onlyLeafParent.id, "deep-child");
  const deepChild = node("deep-child", deep.id);
  const onlyLeaf = node("only-leaf", onlyLeafParent.id);
  const soloParent = node("solo-parent", deepChild.id, "solo");
  const solo = node("solo", soloParent.id);
  const state = {
    nodes: [root, continued, continuedChild, leafA, leafB, namedLeaf, onlyLeafParent, deep, deepChild, onlyLeaf, soloParent, solo],
    activeRootId: root.id,
    tags: [{ nodeId: namedLeaf.id }]
  };

  assert.deepEqual(unusedTakePruneSelection(state), {
    takeIds: [leafA.id, leafB.id],
    nodeIds: [leafA.id, leafB.id]
  });
});

test("story tree: unused-take pruning keeps the remembered leaf and includes non-line descendants", () => {
  const root = node("root", null, "kept");
  const kept = node("kept", root.id);
  const pruned = node("pruned", root.id);
  const summary = node("summary", pruned.id, null, { role: "summary", chapterBreakId: "break" });
  const state = {
    nodes: [root, kept, pruned, summary],
    activeRootId: root.id,
    tags: []
  };

  assert.deepEqual(unusedTakePruneSelection(state), {
    takeIds: [pruned.id],
    nodeIds: [pruned.id, summary.id]
  });
});

test("story tree: unused-take pruning keeps the active unnamed leaf beside a named leaf", () => {
  const root = node("root", null, "active-leaf");
  const activeLeaf = node("active-leaf", root.id);
  const namedLeaf = node("named-leaf", root.id);
  const unusedLeaf = node("unused-leaf", root.id);
  const state = {
    nodes: [root, activeLeaf, namedLeaf, unusedLeaf],
    activeRootId: root.id,
    tags: [{ nodeId: namedLeaf.id }]
  };

  assert.deepEqual(unusedTakePruneSelection(state), {
    takeIds: [unusedLeaf.id],
    nodeIds: [unusedLeaf.id]
  });
});

test("story tree: switching siblings retargets ancestors and preserves remembered descendants", () => {
  const root = node("root", null, "left");
  const left = node("left", root.id, "left-leaf");
  const right = node("right", root.id, "right-child");
  const leftLeaf = node("left-leaf", left.id);
  const rightChild = node("right-child", right.id, "right-leaf");
  const rightLeaf = node("right-leaf", rightChild.id);
  const state = line([root, left, right, leftLeaf, rightChild, rightLeaf], root.id);

  switchToNode(state, right.id);

  assert.equal(root.activeChildId, right.id);
  assert.equal(right.activeChildId, rightChild.id);
  assert.deepEqual(activePath(state).map(({ id }) => id), [root.id, right.id, rightChild.id, rightLeaf.id]);
  assert.deepEqual(state.recentNodeIds, [leftLeaf.id]);
});

test("story tree: switching to a node on the active path leaves recents unchanged", () => {
  const root = node("root", null, "middle");
  const middle = node("middle", root.id, "leaf");
  const leaf = node("leaf", middle.id);
  const state = line([root, middle, leaf], root.id, ["existing"]);

  switchToNode(state, middle.id);

  assert.deepEqual(activePath(state), [root, middle, leaf]);
  assert.deepEqual(state.recentNodeIds, ["existing"]);
});

test("story tree: cross-root switches update the root and keep recents deduped at five", () => {
  const oldRoot = node("old-root");
  const newRoot = node("new-root");
  const recentA = node("recent-a");
  const recentB = node("recent-b");
  const recentC = node("recent-c");
  const recentD = node("recent-d");
  const state = line(
    [oldRoot, newRoot, recentA, recentB, recentC, recentD],
    oldRoot.id,
    [recentA.id, newRoot.id, recentB.id, recentC.id, recentD.id]
  );
  const recents = state.recentNodeIds;

  switchToNode(state, newRoot.id);
  assert.equal(state.activeRootId, newRoot.id);
  assert.strictEqual(state.recentNodeIds, recents);
  assert.deepEqual(state.recentNodeIds, [oldRoot.id, recentA.id, newRoot.id, recentB.id, recentC.id]);

  switchToNode(state, oldRoot.id);
  assert.equal(state.activeRootId, oldRoot.id);
  assert.deepEqual(state.recentNodeIds, [newRoot.id, oldRoot.id, recentA.id, recentB.id, recentC.id]);
  assert.equal(state.recentNodeIds.length, 5);
});

function tree(nodes: StoryNode[], activeRootId: string | null): TreeState {
  return { nodes, activeRootId };
}

function line(
  nodes: StoryNode[],
  activeRootId: string | null,
  recentNodeIds: string[] = []
): LineState {
  return { nodes, activeRootId, recentNodeIds };
}

function node(
  id: string,
  parentId: string | null = null,
  activeChildId: string | null = null,
  options: { createdAt?: string; updatedAt?: string; role?: "summary"; chapterBreakId?: string } = {}
): StoryNode {
  return {
    id,
    parentId,
    instruction: "Continue",
    text: id,
    model: "test",
    createdAt: options.createdAt ?? at(1),
    updatedAt: options.updatedAt,
    role: options.role,
    chapterBreakId: options.chapterBreakId,
    activeChildId
  };
}

function at(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}
