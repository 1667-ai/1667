import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertWithinBudget, cpuBudget, startTiming } from "./performance-budget.js";
import { activeLineFingerprintSource } from "../shared/story-text.js";
import { activePath } from "../shared/story-tree.js";
import { MAX_STORY_LINE_COPY_PARTS, type Story, type StoryNode } from "../shared/types.js";
import { HttpError } from "../server/http.js";
import {
  CLEANUP_MARKER_FILENAME,
  STORY_CLEANUP_IO_CONCURRENCY,
  markCleanupPending
} from "../server/story-cleanup.js";
import { StoryObjectStore } from "../server/story-objects.js";
import {
  chunkId,
  createRevision,
  revisionId,
  sha256,
  type StoryManifestV4
} from "../server/story-format.js";
import { STORY_LIST_IO_CONCURRENCY, StoryStore } from "../server/stories.js";
import {
  pasteStoryLine as pasteStoryLineNodes,
  pruneUnusedTakes as pruneUnusedStoryTakes
} from "../server/story-nodes.js";
import { summarySourceFingerprint, type SummaryPoint } from "../server/summary-take.js";

const NOW = "2026-01-01T00:00:00.000Z";

test("story store: node create, edit, delete, and list summaries use active-path data", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("crud", [node("root", null, "Opening")], "root");
  await store.save(story);
  const created = await store.createNode(story.id, "root", "A human take", "Turn left");
  const take = created.nodes.at(-1)!;
  assert.equal(take.parentId, "root");
  assert.equal(take.human, true);
  assert.deepEqual(activePath(created).map(({ id }) => id), ["root", take.id]);

  const edited = await store.editNode(story.id, take.id, {
    text: "A revised human take", instruction: "Turn sharply left", expectedTextHash: sha256(take.text)
  });
  const revised = edited.nodes.find((candidate) => candidate.id === take.id)!;
  assert.equal(revised.text, "A revised human take");
  assert.equal(revised.instruction, "Turn sharply left");
  assert.equal(revised.attribution?.source, "human");
  assert.ok(revised.updatedAt);
  await assert.rejects(
    () => store.editNode(story.id, take.id, { text: "stale", expectedTextHash: sha256(take.text) }),
    (error: unknown) => error instanceof HttpError && error.status === 409
  );

  const summary = (await store.list()).find((entry) => entry.id === story.id)!;
  assert.equal(summary.partCount, 2);
  assert.equal(summary.words, 5);
  assert.equal(summary.lineCount, 1);
  assert.equal(summary.forked, false);
  const deleted = await store.deleteNode(story.id, take.id, 1);
  assert.deepEqual(deleted.nodes.map(({ id }) => id), ["root"]);
});

test("story store: editing a node that fully reclaims its rewritten span deletes the field instead of storing an empty array", async (t) => {
  // `rewrittenSpansAfterHumanEdit` (shared/human-edit.ts) itself returns an
  // empty array whether it started with no spans at all or with spans the
  // edit fully reclaimed — that function has no opinion on absence. Absence
  // is `applyHumanEdit`'s call (server/story-nodes.ts): it deletes
  // `rewrittenSpans` rather than persisting `[]`, so a node the writer has
  // fully taken back reads the same on disk as a node the model never
  // touched. This is what "rewrittenSpansAfterHumanEdit returns an empty
  // array, not a span, when there were none to begin with"
  // (human-edit.test.ts) used to claim without checking.
  const { store } = await testStore(t);
  // Same before/after pair and the same fully-overwritten span ("door") as
  // "writing over the entire rewritten span reclaims all of it"
  // (human-edit.test.ts) — this only adds the persistence step that unit
  // test does not reach.
  const take = { ...node("take", "root", "The old door creaked once."), rewrittenSpans: [{ start: 8, end: 12 }] };
  const story = fixture("reclaim", [node("root", null, "Opening"), take], "root");
  await store.save(story);

  const edited = await store.editNode(story.id, take.id, {
    text: "The old gate creaked once.", expectedTextHash: sha256(take.text)
  });
  const revised = edited.nodes.find((candidate) => candidate.id === take.id)!;
  assert.equal("rewrittenSpans" in revised, false);
});

test("story store: listing bounds concurrent manifest reads", async (t) => {
  const { dir, store } = await testStore(t);
  const count = STORY_LIST_IO_CONCURRENCY * 3;
  for (let index = 0; index < count; index += 1) {
    await store.save(fixture(`listed-${index}`, [node(`root-${index}`, null, `Story ${index}`)], `root-${index}`));
  }
  const observed = new ObservedListStoryStore(dir);
  const summaries = await observed.list();

  assert.equal(summaries.length, count);
  assert.ok(observed.maxActiveIo > 1, "the test exercised concurrent listing");
  assert.ok(
    observed.maxActiveIo <= STORY_LIST_IO_CONCURRENCY,
    `listing opened ${observed.maxActiveIo} manifests concurrently`
  );
});

test("story store: lazy reads bound concurrent cleanup sweeps without a startup scan", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-cleanup-concurrency-"));
  const seed = new StoryStore(dir);
  await seed.init();
  const count = STORY_CLEANUP_IO_CONCURRENCY * 3;
  for (let index = 0; index < count; index += 1) {
    const id = `cleanup-${index}`;
    await seed.save(fixture(id, [node(`root-${index}`, null, `Story ${index}`)], `root-${index}`));
    await markCleanupPending(path.join(dir, id), id);
  }

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const atCapacity = new Promise<void>((resolve) => { ready = resolve; });
  let active = 0;
  let started = 0;
  let maxActive = 0;
  const observed = new StoryStore(dir, async () => {
    active += 1;
    started += 1;
    maxActive = Math.max(maxActive, active);
    if (started === STORY_CLEANUP_IO_CONCURRENCY) ready();
    await gate;
    active -= 1;
    return true;
  });
  t.after(async () => { release(); await observed.waitForMaintenance(); await rm(dir, { recursive: true, force: true }); });

  await observed.init();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 0, "startup does not scan the catalog for cleanup work");
  const loads = Array.from(
    { length: count },
    (_, index) => observed.load(`cleanup-${index}`)
  );
  await atCapacity;
  assert.equal(active, STORY_CLEANUP_IO_CONCURRENCY);
  assert.equal(started, STORY_CLEANUP_IO_CONCURRENCY, "queued stories have not begun sweeping");
  release();
  await Promise.all(loads);
  await observed.waitForMaintenance();
  assert.equal(started, count);
  assert.equal(maxActive, STORY_CLEANUP_IO_CONCURRENCY);
});

test("story store: releasing the last provider pin preserves cleanup intent for a second sweep", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-cleanup-pin-release-"));
  const seed = new StoryStore(dir);
  await seed.init();
  const story = fixture(
    "cleanup-pin-release",
    [node("root", null, "Opening")],
    "root"
  );
  await seed.save(story);
  await seed.waitForMaintenance();

  let releaseSweep!: () => void;
  const sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
  let markSweepStarted!: () => void;
  const sweepStarted = new Promise<void>((resolve) => {
    markSweepStarted = resolve;
  });
  let sweeps = 0;
  const observed = new StoryStore(dir, async () => {
    sweeps += 1;
    if (sweeps === 1) {
      markSweepStarted();
      await sweepGate;
    }
    return true;
  });
  await observed.init();
  t.after(async () => {
    releaseSweep();
    await observed.waitForMaintenance();
    await rm(dir, { recursive: true, force: true });
  });

  let releasePin!: () => void;
  await observed.withAggregateSession(story.id, async (session) => {
    releasePin = observed.pinProviderSnapshot(session);
  });
  await observed.waitForMaintenance();
  await markCleanupPending(path.join(dir, story.id), story.id);
  await observed.schedulePendingCleanup(story.id);
  await sweepStarted;
  releasePin();
  releaseSweep();
  await observed.waitForMaintenance();

  assert.equal(sweeps, 2);
  await assert.rejects(
    () => readFile(path.join(dir, story.id, CLEANUP_MARKER_FILENAME)),
    (error: unknown) =>
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
  );
});

test("story store: subtree deletion re-anchors by sibling order and guards the confirmed count", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("delete", [
    node("root", null, "root", "a"), node("a", "root", "a", "a-child"), node("a-child", "a", "deep"),
    node("b", "root", "b"), node("c", "root", "c")
  ], "root");
  await store.save(story);
  await assert.rejects(
    () => store.deleteNode(story.id, "a", 1),
    (error: unknown) => error instanceof HttpError && error.status === 409
  );
  const after = await store.deleteNode(story.id, "a", 2);
  assert.deepEqual(after.nodes.map(({ id }) => id), ["root", "b", "c"]);
  assert.equal(after.nodes[0]!.activeChildId, "b", "next surviving sibling wins");
  assert.deepEqual(activePath(after).map(({ id }) => id), ["root", "b"]);

  const afterB = await store.deleteNode(story.id, "b", 1);
  assert.equal(afterB.nodes[0]!.activeChildId, "c");
  const afterC = await store.deleteNode(story.id, "c", 1);
  assert.equal(afterC.nodes[0]!.activeChildId, null);
});

test("story store: deleting a descendant repairs an inactive subtree's remembered child", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("inactive-delete", [
    node("A", null, "A", "B"), node("B", "A", "B", "D"),
    node("D", "B", "D"), node("C", "A", "C")
  ], "A");
  await store.save(story);
  await store.switchLine(story.id, "C");
  await store.deleteNode(story.id, "D", 1);

  const reloaded = await store.load(story.id);
  assert.deepEqual(activePath(reloaded).map(({ id }) => id), ["A", "C"]);
  assert.equal(reloaded.nodes.find(({ id }) => id === "B")!.activeChildId, null);
});

// An HTTP or storage fixture for a 5,001-part chain makes this single bound
// check dominate the suite. The HTTP integration tests cover the other paste
// validation. This component test supplies the only impractical boundary.
test("story nodes: pasting a story line rejects a chain over the size cap", () => {
  const chainIds = Array.from({ length: MAX_STORY_LINE_COPY_PARTS + 1 }, (_, index) => `chain-${index}`);
  const chainNodes = chainIds.map((id, index) =>
    node(id, index === 0 ? "root" : chainIds[index - 1]!, `part ${index}`, chainIds[index + 1] ?? null));
  // `target` is a second opening take (its own root, parentId null) so it
  // sits outside `root`'s subtree — otherwise the self/descendant guard
  // would reject the request before the size cap ever runs.
  const story = fixture("paste-oversized", [
    node("root", null, "root", chainIds[0]),
    node("target", null, "target"),
    ...chainNodes
  ], "root");
  assert.throws(
    () => pasteStoryLineNodes(story, "root", "target", chainIds.at(-1)!),
    (error: unknown) => error instanceof HttpError && error.status === 400
  );
});

test("story store: pasted parts keep authored provenance without generation metadata", async (t) => {
  const { store } = await testStore(t);
  const generated = node("generated", "source", "Model prose", "human-part");
  generated.model = "provider-model";
  generated.genId = "generation-attempt";
  generated.rewrittenSpans = [{ start: 0, end: 5 }];
  generated.attribution = { source: "human", ranges: [{ start: 6, end: 11 }] };
  const human = node("human-part", generated.id, "Human prose");
  human.model = "human";
  human.human = true;
  const story = fixture("paste-metadata", [
    node("source", null, "Source", generated.id),
    generated,
    human,
    node("target", null, "Target")
  ], "source");
  await store.save(story);

  const pasted = await store.pasteStoryLine(story.id, "target", {
    sourceNodeId: "source",
    expectedLeafId: human.id
  });
  const [, clonedGenerated, clonedHuman] = activePath(pasted);

  assert.equal(clonedGenerated!.text, generated.text);
  assert.equal(clonedGenerated!.model, "copied");
  assert.equal(clonedGenerated!.genId, undefined);
  assert.equal(clonedGenerated!.rewrittenSpans, undefined);
  assert.deepEqual(clonedGenerated!.attribution, generated.attribution);
  assert.notEqual(clonedGenerated!.attribution, generated.attribution);
  assert.equal(clonedHuman!.model, "copied");
  assert.equal(clonedHuman!.human, true);

  const unchanged = pasted.nodes.find(({ id }) => id === generated.id)!;
  assert.equal(unchanged.model, "provider-model");
  assert.equal(unchanged.genId, "generation-attempt");
  assert.deepEqual(unchanged.rewrittenSpans, [{ start: 0, end: 5 }]);
});

test("story store: unused-take pruning is atomic, preserves intent, and rejects a stale preview", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("prune-unused", [
    node("root", null, "root", "continued"),
    node("continued", "root", "continued", "deep"), node("deep", "continued", "deep"),
    node("draft-a", "root", "draft a"), node("draft-b", "root", "draft b"),
    node("named", "root", "named")
  ], "root");
  story.tags.push({ nodeId: "named", name: "Named line", status: "Alt", color: "#123", createdAt: NOW });
  await store.save(story);

  await assert.rejects(
    () => store.pruneUnusedTakes(story.id, {
      expectedStoryRevision: "stale",
      expectedTakeCount: 2,
      expectedPartCount: 2
    }),
    (error: unknown) => error instanceof HttpError && error.status === 409
  );
  const preview = {
    expectedStoryRevision: story.updatedAt,
    expectedTakeCount: 2,
    expectedPartCount: 2
  };
  await store.editNode(story.id, "draft-a", {
    instruction: "Newly revised direction",
    expectedTextHash: sha256("draft a")
  });
  await assert.rejects(
    () => store.pruneUnusedTakes(story.id, preview),
    (error: unknown) => error instanceof HttpError && error.status === 409
  );
  assert.ok((await store.load(story.id)).nodes.some(({ id }) => id === "draft-a"), "stale confirmation deletes nothing");

  const refreshed = await store.load(story.id);
  const pruned = await store.pruneUnusedTakes(story.id, {
    expectedStoryRevision: refreshed.updatedAt,
    expectedTakeCount: 2,
    expectedPartCount: 2
  });
  assert.deepEqual(pruned.nodes.map(({ id }) => id), ["root", "continued", "deep", "named"]);
  assert.equal(pruned.tags[0]?.nodeId, "named");
  assert.deepEqual(activePath(pruned).map(({ id }) => id), ["root", "continued", "deep"]);
});

test("story nodes: unused-take pruning stays linear across a 20k-take fork", (context) => {
  const takeCount = 20_000;
  const activeId = `take-${takeCount - 1}`;
  const root = node("root", null, "root", activeId);
  const takes = Array.from({ length: takeCount }, (_, index) => node(`take-${index}`, root.id, `take ${index}`));
  const story = fixture("wide-prune", [root, ...takes], root.id);
  const read = startTiming();
  const pruned = pruneUnusedStoryTakes(story, {
    expectedStoryRevision: story.updatedAt,
    expectedTakeCount: takeCount - 1,
    expectedPartCount: takeCount - 1
  });
  const timing = read();

  assert.equal(pruned, takeCount - 1);
  assert.deepEqual(story.nodes.map(({ id }) => id), [root.id, activeId]);
  assertWithinBudget(context, "20k-take prune", cpuBudget(1_000), timing);
});

test("story store: tag canon, color, advance, and deletion rules persist", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("tags", [node("root", null, "root", "left"), node("left", "root", "left"), node("right", "root", "right")], "root");
  await store.save(story);
  await store.setTag(story.id, "left", "Left line", "Canon");
  let saved = await store.setTag(story.id, "right", "Right line", "Canon");
  assert.equal(saved.tags.find((tag) => tag.nodeId === "left")!.status, "Alt");
  assert.equal(saved.tags.find((tag) => tag.nodeId === "right")!.status, "Canon");
  assert.equal(saved.tags[0]!.color, "#4b45c9");
  assert.equal(saved.tags[1]!.color, "#2f9e6b");

  await store.switchLine(story.id, "right");
  saved = await store.createNode(story.id, "right", "continued", "Continue");
  const child = saved.nodes.at(-1)!;
  assert.equal(saved.tags.find((tag) => tag.name === "Right line")!.nodeId, child.id);
  const forked = await store.createNode(story.id, "right", "sibling", "Fork");
  assert.equal(forked.tags.find((tag) => tag.name === "Right line")!.nodeId, child.id, "forking a non-leaf does not move it");
  const deleted = await store.deleteNode(story.id, child.id, 1);
  assert.equal(deleted.tags.some((tag) => tag.name === "Right line"), false);
});

test("story store: naming a new canon demotes the previous one to Alt and keeps the rest of its tag", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("canon-handover", [
    node("root", null, "root", "left"), node("left", "root", "left"), node("right", "root", "right")
  ], "root");
  await store.save(story);
  const first = await store.setTag(story.id, "left", "The long winter", "Canon");
  const before = first.tags.find((tag) => tag.nodeId === "left")!;

  const saved = await store.setTag(story.id, "right", "The short winter", "Canon");
  const demoted = saved.tags.find((tag) => tag.nodeId === "left")!;

  // Alt, not "": the writer named this line and kept it, so it stays visibly a
  // line they chose rather than dropping to a state that renders like an
  // untagged leaf.
  assert.equal(demoted.status, "Alt");
  assert.equal(demoted.name, "The long winter", "the demoted line keeps its name");
  assert.equal(demoted.color, before.color, "and its colour");
  assert.equal(demoted.createdAt, before.createdAt, "and when it was made");
  assert.equal(
    saved.tags.filter((tag) => tag.status === "Canon").length,
    1,
    "canon stays a singleton"
  );
});

test("story store: an inactive parent gets a sibling take without moving its tag or active path", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("inactive-create", [
    node("root", null, "root", "C"), node("B", "root", "B"), node("C", "root", "C")
  ], "root");
  story.tags.push({ nodeId: "B", name: "Remember B", status: "Alt", color: "#123", createdAt: NOW });
  await store.save(story);

  let saved = await store.createNode(story.id, "B", "B continues", "Keep going");
  const child = saved.nodes.at(-1)!;
  assert.equal(child.parentId, "B");
  assert.deepEqual(activePath(saved).map(({ id }) => id), ["root", "C"]);
  assert.equal(saved.tags[0]!.nodeId, "B");

  saved = await store.setTag(story.id, "B", "Updated B", "Draft");
  assert.equal(saved.tags[0]!.name, "Updated B", "an existing migrated non-leaf tag remains editable");
  assert.equal(saved.tags[0]!.status, "Draft");
});

test("story store: a logical line end with an inactive child can still be named", async (t) => {
  const { store } = await testStore(t);
  // "end" finishes the active line (activeChildId null) while an inactive
  // child hangs below — the shape a switched-away summary commit leaves.
  const story = fixture("line-end-tag", [
    node("root", null, "root", "end"), node("end", "root", "the line ends here"),
    node("inactive-child", "end", "a summary committed after switching away")
  ], "root");
  await store.save(story);

  const saved = await store.setTag(story.id, "end", "Named ending", "Alt");
  assert.equal(saved.tags[0]!.nodeId, "end");

  await assert.rejects(
    store.setTag(story.id, "root", "Mid-line", "Draft"),
    /end of a line/i,
    "a node whose line continues below it cannot take a new tag"
  );
});

test("story store: switches remember previous leaves and persist recents", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("switch", [
    node("root", null, "root", "left"), node("left", "root", "left", "left-leaf"),
    node("left-leaf", "left", "left leaf"), node("right", "root", "right", "right-leaf"),
    node("right-leaf", "right", "right leaf")
  ], "root");
  await store.save(story);
  const switched = await store.switchLine(story.id, "right");
  assert.deepEqual(activePath(switched).map(({ id }) => id), ["root", "right", "right-leaf"]);
  assert.deepEqual(switched.recentNodeIds, ["left-leaf"]);
  const reloaded = await store.load(story.id);
  assert.deepEqual(reloaded.recentNodeIds, ["left-leaf"]);
});

test("story store: switch undo can restore a line ending that gained an inactive child", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("switch-stop", [
    node("root", null, "root"), node("summary", "root", "summary")
  ], "root");
  await store.save(story);

  const switched = await store.switchLine(story.id, "summary");
  assert.deepEqual(activePath(switched).map(({ id }) => id), ["root", "summary"]);
  const restored = await store.switchLine(story.id, "root", { stopAtNode: true });
  assert.deepEqual(activePath(restored).map(({ id }) => id), ["root"]);
  assert.equal(restored.nodes.find(({ id }) => id === "root")!.activeChildId, null);
  assert.deepEqual(restored.recentNodeIds, ["summary", "root"]);
});

test("story store: compare-and-switch requires the complete launch-line fingerprint", async (t) => {
  const { dir, store } = await testStore(t);
  const story = fixture("switch-cas", [
    node("root", null, "root", "left"), node("left", "root", "left"), node("summary", "root", "summary")
  ], "root");
  await store.save(story);
  const beforeMiss = await readFile(path.join(dir, story.id, "manifest.json"), "utf8");

  const missed = await store.switchLine(story.id, "summary", {
    expectedLineFingerprint: sha256("stale line")
  });
  assert.deepEqual(activePath(missed).map(({ id }) => id), ["root", "left"]);
  assert.equal(await readFile(path.join(dir, story.id, "manifest.json"), "utf8"), beforeMiss);

  const launchFingerprint = sha256(activeLineFingerprintSource(story.title, activePath(story)));
  const edited = await store.editNode(story.id, "root", {
    text: "root changed after launch", expectedTextHash: sha256("root")
  });
  assert.equal(edited.nodes.find(({ id }) => id === "left")!.text, "left", "the leaf itself stayed unchanged");
  const beforeTextMiss = await readFile(path.join(dir, story.id, "manifest.json"), "utf8");
  const textMiss = await store.switchLine(story.id, "summary", {
    expectedLineFingerprint: launchFingerprint
  });
  assert.deepEqual(activePath(textMiss).map(({ id }) => id), ["root", "left"]);
  assert.equal(textMiss.nodes.find(({ id }) => id === "root")!.text, "root changed after launch");
  assert.equal(await readFile(path.join(dir, story.id, "manifest.json"), "utf8"), beforeTextMiss);

  const currentFingerprint = sha256(activeLineFingerprintSource(edited.title, activePath(edited)));
  const switched = await store.switchLine(story.id, "summary", {
    expectedLineFingerprint: currentFingerprint
  });
  assert.deepEqual(activePath(switched).map(({ id }) => id), ["root", "summary"]);
  assert.deepEqual(switched.recentNodeIds, ["left"]);
});

test("story store: switching from another line into an asynchronously inserted child advances its endpoint tag", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("async-child", [
    node("root", null, "root", "C"), node("B", "root", "B"),
    node("summary", "B", "summary"), node("C", "root", "C")
  ], "root");
  story.tags.push({ nodeId: "B", name: "Async line", status: "Alt", color: "#123", createdAt: NOW });
  await store.save(story);

  const saved = await store.switchLine(story.id, "summary");
  assert.equal(saved.tags[0]!.nodeId, "summary");
  assert.deepEqual(activePath(saved).map(({ id }) => id), ["root", "B", "summary"]);
});

test("story store: continuing after switching takes records the prior active leaf without dropping older recents", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("create-recents", [
    node("root", null, "root", "B"), node("A", "root", "A"), node("B", "root", "B")
  ], "root");
  await store.save(story);
  await store.switchLine(story.id, "A");
  const saved = await store.createNode(story.id, "A", "A continues", "Continue A");
  assert.deepEqual(saved.recentNodeIds, ["A", "B"]);
});

test("story store: cutting a summary take preserves its role and clips attribution", async (t) => {
  const { store } = await testStore(t);
  const summary = node("summary", null, "Alpha beta gamma") as StoryNode;
  summary.role = "summary";
  summary.attribution = { source: "human", ranges: [{ start: 6, end: 15 }], deletedCharacters: 4 };
  const story = fixture("summary-cut", [summary], "summary");
  await store.save(story);

  const saved = await store.createTakeFromCut(story.id, summary.id, 10, "beta");
  const cut = saved.nodes.at(-1)!;
  assert.equal(cut.text, "Alpha beta");
  assert.equal(cut.role, "summary");
  assert.equal(cut.human, undefined);
  assert.equal(cut.genId, undefined);
  assert.deepEqual(cut.attribution, {
    source: "human", ranges: [{ start: 6, end: 10 }], deletedCharacters: 4
  });
});

test("story store: summary cancellation after lazy hydration saves no take", async (t) => {
  const { store } = await testStore(t);
  const story = fixture("summary-hydration-cancel", [node("root", null, "Source prose")], "root");
  await store.save(story);
  const point: SummaryPoint = { nodeId: "root", offset: null };
  const fingerprint = summarySourceFingerprint(story.title, story.nodes, point);
  const abort = new AbortController();
  const hydrate = store.hydratePath.bind(store);
  store.hydratePath = async (source, nodeId) => {
    await hydrate(source, nodeId);
    abort.abort();
  };

  await assert.rejects(
    () => store.commitProviderEffect(story.id, {
      kind: "summary-take",
      point,
      expected: null,
      sourceFingerprint: fingerprint,
      summary: "Recap",
      model: "test",
      instruction: "Summarize",
      commitIds: {},
      cancelled: abort.signal
    }),
    (error: unknown) => error instanceof HttpError && error.status === 409 && /cancelled/.test(error.message)
  );
  assert.deepEqual((await store.load(story.id)).nodes.map(({ id }) => id), ["root"]);
});

test("story store: GC keeps untouched sibling revisions after deleting elsewhere", async (t) => {
  const { dir, store } = await testStore(t);
  const story = fixture("gc", [node("root", null, "root", "left"), node("left", "root", "left"), node("right", "root", "right")], "root");
  await store.save(story);
  const before = await manifest(dir, story.id);
  const rightRevision = before.nodes.find((stored) => stored.id === "right")!.revisionId;
  await store.deleteNode(story.id, "left", 1);
  await store.waitForMaintenance();
  const reloaded = await store.load(story.id);
  assert.equal(reloaded.nodes.find((candidate) => candidate.id === "right")!.text, "right");
  const after = await manifest(dir, story.id);
  assert.equal(after.nodes.find((stored) => stored.id === "right")!.revisionId, rightRevision);
  await readFile(new StoryObjectStore(path.join(dir, story.id)).objectPath("revisions", rightRevision));
});

test("story store: a durable marker retries an interrupted object sweep after restart", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-cleanup-retry-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const interrupted = new StoryStore(dir, async () => { throw new Error("simulated sweep interruption"); });
  await interrupted.init();
  const story = fixture("cleanup-retry", [
    node("root", null, "Live root", "stale"), node("stale", "root", "Stale child")
  ], "root");
  await interrupted.save(story);
  const staleRevision = (await manifest(dir, story.id)).nodes.find(({ id }) => id === "stale")!.revisionId;

  await interrupted.deleteNode(story.id, "stale", 1);
  await interrupted.waitForMaintenance();
  await readFile(path.join(dir, story.id, CLEANUP_MARKER_FILENAME));
  await readFile(new StoryObjectStore(path.join(dir, story.id)).objectPath("revisions", staleRevision));

  const recovered = new StoryStore(dir);
  await recovered.init();
  await recovered.load(story.id);
  await recovered.waitForMaintenance();
  await assert.rejects(
    () => readFile(path.join(dir, story.id, CLEANUP_MARKER_FILENAME)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
  );
  await assert.rejects(
    () => readFile(new StoryObjectStore(path.join(dir, story.id)).objectPath("revisions", staleRevision)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
  );
  assert.equal((await recovered.load(story.id)).nodes[0]!.text, "Live root");
});

test("story objects reject symlinked roots and shards before writes or sweep", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-object-symlink-"));
  const external = await mkdtemp(path.join(tmpdir(), "1667-object-external-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });

  const unsafeBundle = path.join(root, "unsafe");
  await mkdir(unsafeBundle);
  await symlink(
    external,
    path.join(unsafeBundle, "chunks"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(
    new StoryObjectStore(unsafeBundle).init(),
    /retained no-follow directory/
  );

  const bundle = path.join(root, "sweep");
  const objects = new StoryObjectStore(bundle);
  await objects.init();
  const text = "external object must survive";
  await objects.storeText(text);
  await objects.flush();
  const hash = chunkId(text);
  const shard = hash.slice(0, 2);
  const shardPath = path.join(bundle, "chunks", shard);
  await rename(shardPath, `${shardPath}.retained`);
  const outsideObject = path.join(external, `${hash}.txt`);
  await writeFile(outsideObject, text);
  await symlink(
    external,
    shardPath,
    process.platform === "win32" ? "junction" : "dir"
  );

  await assert.rejects(
    objects.sweep({ revisions: [], leaves: { probabilities: [], reasoning: [] }, generationRecords: [] }),
    /Unsafe chunks object shard/
  );
  assert.equal(await readFile(outsideObject, "utf8"), text);
});

test("story store: failed additive publication leaves durable recovery for orphaned objects", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-additive-recovery-"));
  const seed = new StoryStore(dir);
  await seed.init();
  const story = fixture("additive-recovery", [node("root", null, "Live root")], "root");
  await seed.save(story);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let sweepReady!: () => void;
  const sweepStarted = new Promise<void>((resolve) => { sweepReady = resolve; });
  const recovering = new StoryStore(
    dir,
    async (bundleDir, liveRevisionIds, signal) => {
      sweepReady();
      await gate;
      return await new StoryObjectStore(bundleDir).sweep(liveRevisionIds, signal);
    },
    async () => { throw new Error("simulated manifest publication failure"); }
  );
  await recovering.init();
  t.after(async () => { release(); await recovering.waitForMaintenance(); await rm(dir, { recursive: true, force: true }); });

  const orphanText = "Unpublished additive prose";
  const orphanRevision = revisionId(createRevision([chunkId(orphanText)], orphanText.length));
  await assert.rejects(
    () => recovering.createNode(story.id, "root", orphanText, "Continue"),
    /simulated manifest publication failure/
  );
  await sweepStarted;
  const bundleDir = path.join(dir, story.id);
  const objects = new StoryObjectStore(bundleDir);
  await readFile(path.join(bundleDir, CLEANUP_MARKER_FILENAME));
  await readFile(objects.objectPath("revisions", orphanRevision));

  release();
  await recovering.waitForMaintenance();
  await assert.rejects(
    () => readFile(path.join(bundleDir, CLEANUP_MARKER_FILENAME)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
  );
  await assert.rejects(
    () => readFile(objects.objectPath("revisions", orphanRevision)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
  );
  assert.deepEqual((await seed.load(story.id)).nodes.map(({ id }) => id), ["root"]);
});

test("story store: V2 bundles and legacy JSON load, then save as V5", async (t) => {
  const { dir, store } = await testStore(t);
  const bundle = path.join(dir, "old-v2");
  const objects = new StoryObjectStore(bundle);
  await objects.init();
  const revisionId = await objects.storeText("Old prose");
  const obsoleteFactRevision = await objects.storeText("Obsolete temporal fact");
  const selectedFactRevision = await objects.storeText("Selected temporal fact");
  await objects.flush();
  await writeFile(path.join(bundle, "manifest.json"), JSON.stringify({
    format: "1667-story", schemaVersion: 2, id: "old-v2", title: "Old",
    createdAt: NOW, updatedAt: NOW, activeWordCount: 2,
    parts: [{ id: "p1", instruction: "Go", model: "m", createdAt: NOW, revisionIds: [revisionId], activeRevision: 0 }],
    facts: [{
      id: "fact", tag: "Lore", createdAt: NOW, updatedAt: NOW,
      states: [
        { id: "old-state", revisionId: obsoleteFactRevision, effectiveAfterPartId: null, createdAt: NOW, updatedAt: NOW },
        { id: "selected-state", revisionId: selectedFactRevision, effectiveAfterPartId: "p1", createdAt: NOW, updatedAt: NOW }
      ]
    }]
  }));
  const old = await store.load("old-v2");
  assert.equal(old.nodes[0]!.text, "Old prose");
  assert.equal(old.facts[0]!.text, "Selected temporal fact");
  assert.equal(old.facts[0]!.activation, "always");
  assert.deepEqual(old.facts[0]!.keys, []);
  await store.mutate("old-v2", (story) => { story.title = "Migrated"; });
  await store.waitForMaintenance();
  const migrated = await manifest(dir, "old-v2");
  assert.equal(migrated.schemaVersion, 5);
  assert.equal("activation" in migrated.facts[0]!, false);
  assert.equal("keys" in migrated.facts[0]!, false);
  await assert.rejects(
    () => readFile(objects.objectPath("revisions", obsoleteFactRevision)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
  );
  await readFile(objects.objectPath("revisions", selectedFactRevision));

  const legacy = fixture("legacy", [node("p1", null, "Legacy prose")], "p1");
  const legacyRaw = { id: legacy.id, title: legacy.title, createdAt: NOW, updatedAt: NOW,
    parts: [{ id: "p1", instruction: "Go", text: "Legacy prose", model: "m", createdAt: NOW }] };
  await writeFile(path.join(dir, "legacy.json"), JSON.stringify(legacyRaw));
  assert.equal((await store.load("legacy")).nodes[0]!.text, "Legacy prose");
  await store.mutate("legacy", (story) => { story.title = "Saved"; });
  assert.equal((await manifest(dir, "legacy")).schemaVersion, 5);
});

function fixture(id: string, nodes: StoryNode[], activeRootId: string | null): Story {
  return { id, title: "Story", createdAt: NOW, updatedAt: NOW, nodes, activeRootId, tags: [], recentNodeIds: [], facts: [], chapterBreaks: [] };
}

function node(id: string, parentId: string | null, text: string, activeChildId: string | null = null): StoryNode {
  return { id, parentId, instruction: "Continue", text, model: "test", createdAt: NOW, activeChildId };
}

async function testStore(t: test.TestContext): Promise<{ dir: string; store: StoryStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-tree-store-"));
  const store = new StoryStore(dir);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store };
}

async function manifest(dir: string, id: string): Promise<StoryManifestV4> {
  return JSON.parse(await readFile(path.join(dir, id, "manifest.json"), "utf8")) as StoryManifestV4;
}

class ObservedListStoryStore extends StoryStore {
  activeIo = 0;
  maxActiveIo = 0;

  protected override async withIo<T>(
    id: string,
    work: () => Promise<T>,
    maintenance = false
  ): Promise<T> {
    this.activeIo += 1;
    this.maxActiveIo = Math.max(this.maxActiveIo, this.activeIo);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      return await super.withIo(id, work, maintenance);
    } finally {
      this.activeIo -= 1;
    }
  }
}
