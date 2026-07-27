import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeStoryBundle, encodeStoryBundle } from "../server/story-codec.js";
import { SYNTHETIC_EMPTY_REVISION_ID } from "../server/story-empty-revision.js";
import {
  createRevision,
  parseManifest,
  revisionId,
  serializeManifest,
  type StoredPartV2,
  type StoryManifestV3,
  type StoryManifestV4
} from "../server/story-format.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { switchToNode } from "../shared/story-tree.js";

const NOW = "2026-01-01T00:00:00.000Z";
const hash = (character: string) => character.repeat(64);

test("story migration: a V4 manifest loads with no chapter breaks and round-trips as V5", () => {
  const old: StoryManifestV4 = {
    format: "1667-story",
    schemaVersion: 4,
    id: "old-chapterless",
    title: "Old",
    createdAt: NOW,
    updatedAt: NOW,
    activeWordCount: 1,
    nodes: [{
      id: "root", parentId: null, instruction: "Go", model: "test", createdAt: NOW,
      revisionId: hash("a"), activeChildId: null
    }],
    facts: [],
    activeRootId: "root",
    bookmarks: [],
    recentNodeIds: []
  };
  const migrated = parseManifest(JSON.stringify(old), old.id);
  assert.equal(migrated.schemaVersion, 5);
  assert.deepEqual(migrated.chapterBreaks, []);
  assert.deepEqual(parseManifest(serializeManifest(migrated), old.id), migrated);
});

test("story migration: V3 revisions and line shapes become one V5 tree", () => {
  const v3 = fixture();
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  const byId = new Map(migrated.nodes.map((node) => [node.id, node] as const));

  assert.deepEqual(migrated.nodes.slice(0, 3).map((node) => node.id), ["p1@v0", "p1", "p2"]);
  assert.equal(byId.get("p1@v0")!.revisionId, hash("a"));
  assert.equal(byId.get("p1")!.revisionId, hash("b"));
  assert.deepEqual(byId.get("p1@v0")!.attribution, {
    source: "human", ranges: [{ start: 0, end: 1 }], deletedCharacters: 2
  });
  assert.equal(byId.get("p1")!.attribution, null);
  assert.equal(byId.get("p1@v0")!.activeChildId, null, "inactive versions stay childless");

  assert.equal(byId.get("whole-1")!.parentId, "p1", "whole-part tail hangs below the fork's active take");
  assert.equal(byId.get("whole-1")!.activeChildId, "whole-2");
  assert.equal(byId.get("cut-copy")!.parentId, "p1", "cut copy is a sibling of the fork part");
  assert.equal(byId.get("cut-tail")!.parentId, "cut-copy");
  assert.equal(byId.get("summary")!.parentId, null, "summary branches become extra roots");

  assert.deepEqual(activeIds(migrated), ["p1", "cut-copy", "cut-tail"]);
  assert.equal(migrated.activeRootId, "p1");
  assert.deepEqual(migrated.recentNodeIds, []);
  assert.deepEqual(migrated.bookmarks.find((tag) => tag.nodeId === "whole-2"), {
    nodeId: "whole-2", name: "Whole", label: "Canon", color: "#4b45c9", createdAt: NOW
  });
  assert.equal(migrated.bookmarks.find((tag) => tag.nodeId === "cut-tail")?.name, "Cut");
  assert.equal(migrated.bookmarks.some((tag) => tag.nodeId === "p2"), false, "the old main line is not tagged");
  assert.equal(migrated.activeWordCount, v3.activeWordCount);
  assert.equal(JSON.parse(serializeManifest(migrated)).schemaVersion, 5);
});

test("story migration: an offset cut at the first base part becomes a root sibling", () => {
  const v3 = fixture();
  v3.branches = [branch("root-cut", "Root cut", "p1", 3, [part("root-copy", [hash("3")], 0)], "Alt")];
  v3.activeBranchId = "root-cut";
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  const rootCopy = migrated.nodes.find((node) => node.id === "root-copy")!;
  assert.equal(rootCopy.parentId, null);
  assert.equal(migrated.activeRootId, rootCopy.id);
  assert.deepEqual(activeIds(migrated), [rootCopy.id]);
});

test("story migration: versioned branch-tail parts expand to siblings and only the active take carries the chain", () => {
  const v3 = fixture();
  v3.branches = [branch("versioned-tail", "Versioned tail", "p1", null, [
    part("tail-one", [hash("4"), hash("5")], 1),
    part("tail-two", [hash("6")], 0)
  ], "Draft")];
  v3.activeBranchId = "versioned-tail";
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  const byId = new Map(migrated.nodes.map((node) => [node.id, node] as const));
  assert.equal(byId.get("tail-one@v0")!.parentId, "p1");
  assert.equal(byId.get("tail-one@v0")!.activeChildId, null);
  assert.equal(byId.get("tail-one")!.parentId, "p1");
  assert.equal(byId.get("tail-one")!.activeChildId, "tail-two");
  assert.equal(byId.get("tail-two")!.parentId, "tail-one");
  assert.deepEqual(activeIds(migrated), ["p1", "tail-one", "tail-two"]);
});

test("story migration: null activeBranchId reproduces the old base line", () => {
  const v3 = fixture();
  v3.activeBranchId = null;
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  assert.deepEqual(activeIds(migrated), ["p1", "p2"]);
});

test("story migration: activeWordCount survives without loading revision text", () => {
  const v3 = fixture();
  v3.activeWordCount = 1234;
  assert.equal(parseManifest(JSON.stringify(v3), v3.id).activeWordCount, 1234);
});

test("story migration: an active summary branch becomes the active root path", () => {
  const v3 = fixture();
  const summary = v3.branches.find((candidate) => candidate.id === "summary-branch")!;
  summary.parts.push(part("summary-after", [hash("7")], 0));
  v3.activeBranchId = summary.id;
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  assert.equal(migrated.activeRootId, "summary");
  assert.deepEqual(activeIds(migrated), ["summary", "summary-after"]);
});

test("story migration: empty-tail branches become distinct selectable leaf takes", () => {
  const v3 = fixture();
  v3.branches = [
    branch("first", "First", "p1", null, [], "Alt"),
    branch("second", "Second", "p1", null, [], "Draft")
  ];
  v3.activeBranchId = null;
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  assert.deepEqual(migrated.bookmarks.map((tag) => tag.name), ["First", "Second"]);
  assert.notEqual(migrated.bookmarks[0]!.nodeId, migrated.bookmarks[1]!.nodeId);

  switchToNode(migrated, migrated.bookmarks[0]!.nodeId);
  assert.equal(activeIds(migrated).at(-1), migrated.bookmarks[0]!.nodeId);
  switchToNode(migrated, migrated.bookmarks[1]!.nodeId);
  assert.equal(activeIds(migrated).at(-1), migrated.bookmarks[1]!.nodeId);
});

test("story migration: empty offset branches own distinct selectable prefix endings", () => {
  const v3 = fixture();
  v3.branches = [
    branch("cut-first", "Cut first", "p2", 4, [], "Alt"),
    branch("cut-second", "Cut second", "p2", 5, [], "Draft")
  ];
  v3.activeBranchId = "cut-first";
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  const targets = migrated.bookmarks.map(({ nodeId }) => nodeId);

  assert.equal(new Set(targets).size, 2);
  assert.deepEqual(activeIds(migrated), [targets[0]]);
  switchToNode(migrated, "p2");
  assert.deepEqual(activeIds(migrated), ["p1", "p2"]);
  for (const target of targets) {
    switchToNode(migrated, target);
    assert.deepEqual(activeIds(migrated), [target]);
  }
});

test("story migration: empty root and first-part cut branches become exact empty endpoints", () => {
  const v3 = fixture();
  v3.activeWordCount = 0;
  v3.branches = [
    branch("empty-summary", "Empty summary", null, null, [], "Summary"),
    branch("empty-cut", "Empty cut", "p1", 3, [], "Alt")
  ];
  v3.activeBranchId = "empty-summary";
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  const targets = migrated.bookmarks.map(({ nodeId }) => nodeId);

  assert.equal(new Set(targets).size, 2);
  for (const [index, target] of targets.entries()) {
    const node = migrated.nodes.find(({ id }) => id === target)!;
    assert.equal(node.parentId, null);
    assert.equal(node.syntheticEmpty, true);
    assert.equal(node.preview, "");
    assert.equal(node.words, 0);
    assert.equal(node.revisionId, SYNTHETIC_EMPTY_REVISION_ID);
    if (index === 0) assert.equal(node.role, "summary");
    switchToNode(migrated, target);
    assert.deepEqual(activeIds(migrated), [target]);
  }
});

test("story migration: the first V4 save materializes a synthetic empty endpoint", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-empty-branch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const v3 = fixture();
  v3.parts = [];
  v3.activeWordCount = 0;
  v3.branches = [branch("empty-root", "Empty root", null, null, [], "Alt")];
  v3.activeBranchId = "empty-root";
  const transitional = parseManifest(JSON.stringify(v3), v3.id);
  const decoded = await decodeStoryBundle(transitional, dir);
  assert.equal(decoded.story.nodes[0]!.text, "");

  const objects = new StoryObjectStore(dir);
  const saved = await encodeStoryBundle(decoded.story, objects);
  await objects.flush();
  assert.equal(saved.nodes[0]!.syntheticEmpty, undefined);
  assert.equal(saved.nodes[0]!.revisionId, SYNTHETIC_EMPTY_REVISION_ID);
  assert.equal(revisionId(createRevision([], 0)), SYNTHETIC_EMPTY_REVISION_ID);
  assert.equal(await objects.readText(SYNTHETIC_EMPTY_REVISION_ID), "");
});

test("story migration: a final-part branch tail preserves Main as a selectable ending", () => {
  const v3 = fixture();
  v3.branches = [branch(
    "final-tail",
    "Final tail",
    "p2",
    null,
    [part("after-final", [hash("9")], 0)],
    "Alt"
  )];
  v3.activeBranchId = "final-tail";
  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  const byId = new Map(migrated.nodes.map((node) => [node.id, node] as const));
  const tail = byId.get("after-final")!;
  const branchBoundary = byId.get(tail.parentId!)!;

  assert.notEqual(branchBoundary.id, "p2");
  assert.equal(branchBoundary.revisionId, byId.get("p2")!.revisionId);
  assert.equal(branchBoundary.parentId, "p1");
  assert.equal(byId.get("p2")!.activeChildId, null);
  assert.deepEqual(activeIds(migrated), ["p1", branchBoundary.id, tail.id]);

  switchToNode(migrated, "p2");
  assert.deepEqual(activeIds(migrated), ["p1", "p2"]);
  switchToNode(migrated, tail.id);
  assert.deepEqual(activeIds(migrated), ["p1", branchBoundary.id, tail.id]);
  switchToNode(migrated, "p2");
  assert.deepEqual(activeIds(migrated), ["p1", "p2"]);
});

test("story migration: stale Canon labels defer to the authoritative canon flag", () => {
  const v3 = fixture();
  v3.branches.unshift(branch(
    "stale-canon",
    "Former canon",
    "p1",
    null,
    [part("stale-canon-tail", [hash("8")], 0)],
    "Canon"
  ));

  const migrated = parseManifest(JSON.stringify(v3), v3.id);
  assert.equal(migrated.bookmarks.find((tag) => tag.name === "Former canon")?.label, "");
  assert.equal(migrated.bookmarks.find((tag) => tag.name === "Whole")?.label, "Canon");
});

function fixture(): StoryManifestV3 {
  return {
    format: "1667-story", schemaVersion: 3, id: "migration", title: "Migration",
    createdAt: NOW, updatedAt: NOW, activeWordCount: 3, facts: [],
    parts: [{
      ...part("p1", [hash("a"), hash("b")], 1),
      versionAttributions: [{
        source: "human", ranges: [{ start: 0, end: 1 }], deletedCharacters: 2
      }, null]
    }, part("p2", [hash("c")], 0)],
    branches: [
      { ...branch("whole", "Whole", "p1", null, [part("whole-1", [hash("d")], 0), part("whole-2", [hash("e")], 0)], "Alt"), canon: true },
      branch("cut", "Cut", "p2", 4, [part("cut-copy", [hash("f")], 0), part("cut-tail", [hash("1")], 0)], "Draft"),
      branch("summary-branch", "Summary", null, null, [{ ...part("summary", [hash("2")], 0), role: "summary" }], "Summary")
    ],
    activeBranchId: "cut"
  };
}

function part(id: string, revisionIds: string[], activeRevision: number): StoredPartV2 {
  return { id, instruction: "Continue", model: "test", createdAt: NOW, revisionIds, activeRevision };
}

function branch(
  id: string,
  name: string,
  forkPartId: string | null,
  forkOffset: number | null,
  parts: StoredPartV2[],
  label: "" | "Canon" | "Alt" | "Draft" | "Discarded" | "Summary"
): StoryManifestV3["branches"][number] {
  return {
    id, name, color: label === "Summary" ? "#0e9c8a" : "#4b45c9", label, createdAt: NOW,
    forkPartId, forkOffset, forkPartIndex: forkPartId === null ? 0 : forkPartId === "p1" ? 1 : 2, parts
  };
}

function activeIds(manifest: ReturnType<typeof parseManifest>): string[] {
  const byId = new Map(manifest.nodes.map((node) => [node.id, node] as const));
  const ids: string[] = [];
  let current = manifest.activeRootId === null ? undefined : byId.get(manifest.activeRootId);
  while (current !== undefined) {
    ids.push(current.id);
    current = current.activeChildId === null ? undefined : byId.get(current.activeChildId);
  }
  return ids;
}
