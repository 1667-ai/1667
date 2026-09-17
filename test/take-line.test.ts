import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { commitTake } from "../server/story-nodes.js";
import { StoryStore } from "../server/stories.js";
import { switchToNode } from "../shared/story-tree.js";
import { ApiHttpError } from "../tui/src/api-error.js";
import { createApi } from "../tui/src/api.js";
import { attachHttpServer } from "../tui/src/http-attach.js";
import { testApp } from "./story-server-fixture.js";

/**
 * `getTakeLine` (server/stories.ts's `loadTakeLine`): a take's own line
 * beyond the last part it shares with the story's current line — see
 * scratchpad/spec2/C3-compare.md. Mirrors test/reasoning-storage.test.ts's
 * shape: build a tree directly with `commitTake`, walk the result by hand,
 * then confirm the HTTP route agrees.
 */

test("a take off the current line reports the fork and its own line beyond it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-take-line-fork-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const { rootId, currentId, off1Id, off2Id, off3Id } = await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    commitTake(mutable, {
      parentId: null, appendTo: null, expectedTextHash: null,
      instruction: "", text: "Root prose.", model: "dry-run", genId: "gen-fork-root"
    });
    const root = mutable.nodes[0]!;
    commitTake(mutable, {
      parentId: root.id, appendTo: null, expectedTextHash: null,
      instruction: "Continue.", text: "Current line continues.", model: "dry-run", genId: "gen-fork-current"
    });
    const current = mutable.nodes.find((node) => node.genId === "gen-fork-current")!;
    commitTake(mutable, {
      parentId: root.id, appendTo: null, expectedTextHash: null,
      instruction: "Continue.", text: "Off one.", model: "dry-run", genId: "gen-fork-off-1"
    });
    const off1 = mutable.nodes.find((node) => node.genId === "gen-fork-off-1")!;
    commitTake(mutable, {
      parentId: off1.id, appendTo: null, expectedTextHash: null,
      instruction: "Continue.", text: "Off two.", model: "dry-run", genId: "gen-fork-off-2"
    });
    const off2 = mutable.nodes.find((node) => node.genId === "gen-fork-off-2")!;
    commitTake(mutable, {
      parentId: off2.id, appendTo: null, expectedTextHash: null,
      instruction: "Continue.", text: "Off three.", model: "dry-run", genId: "gen-fork-off-3"
    });
    const off3 = mutable.nodes.find((node) => node.genId === "gen-fork-off-3")!;
    // The chain above left off3 active — walk the reader's own line back to
    // "current" so off1..off3 end up the off-path chain under test.
    switchToNode(mutable, current.id);
    await stories.save(mutable);
    return { rootId: root.id, currentId: current.id, off1Id: off1.id, off2Id: off2.id, off3Id: off3.id };
  });
  await stories.waitForMaintenance();

  const read = await stories.loadTakeLine(story.id, off3Id);
  assert.equal(read.forkIndex, 0);
  assert.equal(read.skipped, 0);
  assert.deepEqual(read.parts.map((part) => part.id), [off1Id, off2Id, off3Id]);
  assert.deepEqual(read.parts.map((part) => part.text), ["Off one.", "Off two.", "Off three."]);
  for (const part of read.parts) assert.equal("generationRecordIds" in part, false);

  const onPath = await stories.loadTakeLine(story.id, currentId);
  assert.equal(onPath.forkIndex, 1);
  assert.equal(onPath.skipped, 0);
  assert.deepEqual(onPath.parts, []);

  const rootLine = await stories.loadTakeLine(story.id, rootId);
  assert.equal(rootLine.forkIndex, 0);
  assert.deepEqual(rootLine.parts, []);

  await assert.rejects(() => stories.loadTakeLine(story.id, "missing-node"), /Take not found/);
  await assert.rejects(() => stories.loadTakeLine("missing-story", off3Id), /Take not found/);
});

test("a chain longer than 12 keeps the 12 parts nearest the take", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-take-line-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();
  const story = await stories.create("Story");

  const ids: string[] = await stories.withLock(story.id, async () => {
    const mutable = await stories.loadForMutation(story.id);
    commitTake(mutable, {
      parentId: null, appendTo: null, expectedTextHash: null,
      instruction: "", text: "Root prose.", model: "dry-run", genId: "gen-page-root"
    });
    const root = mutable.nodes[0]!;
    const chain: string[] = [root.id];
    let parentId = root.id;
    for (let index = 0; index < 15; index += 1) {
      const genId = `gen-page-${index}`;
      commitTake(mutable, {
        parentId, appendTo: null, expectedTextHash: null,
        instruction: "Continue.", text: `Off ${index}.`, model: "dry-run", genId
      });
      const node = mutable.nodes.find((candidate) => candidate.genId === genId)!;
      chain.push(node.id);
      parentId = node.id;
    }
    // Each commit above retargeted the active line to itself in turn, so the
    // whole chain is on-path now — pull the current line back to the root,
    // leaving the 15-take chain as the off-path line under test.
    switchToNode(mutable, root.id, { stopAtNode: true });
    await stories.save(mutable);
    return chain;
  });
  await stories.waitForMaintenance();

  const takeId = ids.at(-1)!;
  const read = await stories.loadTakeLine(story.id, takeId);
  assert.equal(read.forkIndex, 0);
  assert.equal(read.skipped, 3);
  assert.equal(read.parts.length, 12);
  assert.deepEqual(read.parts.map((part) => part.id), ids.slice(-12));
  assert.equal(read.parts.at(-1)!.id, takeId);
});

const linuxTest = process.platform === "linux" ? test : test.skip;

linuxTest("the read route returns the same result as the service, and 404s for an unknown take", async (t) => {
  const base = await testApp(t, "1667-take-line-http-");
  const attach = await attachHttpServer(base);
  t.after(() => attach.dispose());
  const api = createApi(base, undefined, attach);

  const created = await api.createStory("Story");
  const rootPayload = await api.createNode(created.id, { parentId: null, text: "Root prose." });
  const rootId = rootPayload.path[0]!.id;
  const off1Payload = await api.createNode(created.id, { parentId: rootId, text: "Off one." });
  const off1Id = off1Payload.path[1]!.id;
  const off2Payload = await api.createNode(created.id, { parentId: off1Id, text: "Off two." });
  const off2Id = off2Payload.path[2]!.id;
  // Created last, so this is what stays on the current line — off1/off2
  // above are left as the off-path chain under test.
  await api.createNode(created.id, { parentId: rootId, text: "Current line continues." });

  const read = await api.getTakeLine(created.id, off2Id);
  assert.equal(read.forkIndex, 0);
  assert.equal(read.skipped, 0);
  assert.deepEqual(read.parts.map((part) => part.id), [off1Id, off2Id]);
  assert.deepEqual(read.parts.map((part) => part.text), ["Off one.", "Off two."]);

  await assert.rejects(
    () => api.getTakeLine(created.id, "missing-node"),
    (error: unknown) => error instanceof ApiHttpError && error.status === 404
  );
});
