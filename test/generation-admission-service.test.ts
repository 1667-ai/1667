import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoryService } from "../server/story-service.js";

test("cancelled continuation releases its story/gen admission for retry", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-generation-admission-"));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  let story = await service.createStory("Cancellation");
  story = await service.createNode(story.id, {
    parentId: null,
    instruction: "Open.",
    text: "Rain crossed the windows."
  });
  const request = {
    parentId: story.path[0]!.id,
    instruction: "Continue.",
    genId: "cancel-then-retry"
  };
  const controller = new AbortController();
  const cancelled = await service.continueStory(
    story.id,
    request,
    () => controller.abort(),
    controller.signal
  );
  assert.equal(cancelled, null);

  const retried = await service.continueStory(
    story.id,
    request,
    () => undefined,
    new AbortController().signal
  );
  assert.ok(retried);
  assert.equal(retried.payload.path.some((node) => node.genId === request.genId), true);
});
