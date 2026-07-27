import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";
import type { StoryPayload } from "../shared/types.js";

/** The takes of one branching beat: two alternatives hang off the same seam,
 * and the first of them carries the line onward. */
const TAKES = [
  { slug: "open", parentId: null, text: "The gate stood open." },
  { slug: "first", parentId: "open", text: "She went in." },
  { slug: "second", parentId: "open", text: "She turned away." },
  { slug: "close", parentId: "first", text: "The gate closed." }
];

function nodeId(slug: string): string {
  return `00000000-0000-4000-8000-0000000000${String(TAKES.findIndex((take) => take.slug === slug) + 10)}`;
}

function takeRequests(): { value: unknown; nodeId: string }[] {
  return TAKES.map((take) => ({
    value: {
      text: take.text,
      instruction: "",
      parentId: take.parentId === null ? null : nodeId(take.parentId)
    },
    nodeId: nodeId(take.slug)
  }));
}

/** Compare the shape a reader gets, not the clock. */
function shape(payload: StoryPayload): unknown {
  return payload.nodes
    .map((node) => ({
      id: node.id,
      parentId: node.parentId,
      text: node.text,
      activeChildId: node.activeChildId
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function withService<T>(
  t: test.TestContext,
  work: (service: StoryService, storyId: string) => Promise<T>
): Promise<T> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-take-batch-"));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  const story = await service.createStory("Batch");
  return await work(service, story.id);
}

test("takes written together give the same story as takes written one at a time", async (t) => {
  const together = await withService(t, async (service, storyId) => {
    await service.createNodes(storyId, takeRequests());
    return shape(await service.loadStory(storyId));
  });
  const separately = await withService(t, async (service, storyId) => {
    for (const take of takeRequests()) {
      await service.createNode(storyId, take.value, take.nodeId);
    }
    return shape(await service.loadStory(storyId));
  });
  assert.equal((together as unknown[]).length, TAKES.length);
  assert.deepEqual(together, separately);
});

test("writing the same takes again repairs rather than duplicates", async (t) => {
  await withService(t, async (service, storyId) => {
    await service.createNodes(storyId, takeRequests());
    const first = await service.loadStory(storyId);
    await service.createNodes(storyId, takeRequests());
    const second = await service.loadStory(storyId);
    assert.equal(second.nodes.length, TAKES.length);
    assert.deepEqual(shape(second), shape(first));
  });
});

test("a batch holding one empty take writes none of them", async (t) => {
  await withService(t, async (service, storyId) => {
    const requests = takeRequests();
    requests.splice(2, 0, {
      value: { text: "   ", instruction: "", parentId: null },
      nodeId: "00000000-0000-4000-8000-0000000000ff"
    });
    await assert.rejects(
      async () => await service.createNodes(storyId, requests),
      /Nothing to save/
    );
    assert.equal((await service.loadStory(storyId)).nodes.length, 0);
  });
});
