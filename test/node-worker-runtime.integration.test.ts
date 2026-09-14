import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkerStoryApi } from "../tui/src/worker-api.js";

test("Node worker_threads bootstraps StoryApi and disposes cleanly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-node-worker-runtime-"));
  const dataDir = path.join(root, "data");
  const machineDir = path.join(root, "machine");
  await mkdir(machineDir);
  try {
    const backend = await createWorkerStoryApi({ dataDir, machineDir });
    try {
      const created = await backend.api.createStory("Node worker integration");
      assert.equal(created.title, "Node worker integration");
      const stories = await backend.api.listStories();
      assert.ok(stories.some((story) => story.id === created.id));
    } finally {
      await backend.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
