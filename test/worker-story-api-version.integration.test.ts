import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { storyApiFromWorkerTransport } from "../client/worker-story-api.js";
import { createWorkerHost } from "../host/worker-host.js";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type { StoryPayload } from "../shared/types.js";

async function expectRevisionConflict(
  operation: Promise<unknown>,
  message: string
): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    (error as { code?: unknown })?.code === "revision_conflict", message);
}

async function withWorker(
  callback: (host: Awaited<ReturnType<typeof createWorkerHost>>) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "1667-worker-story-api-version-"));
  const machineDir = path.join(root, "machine");
  await mkdir(machineDir);
  const host = await createWorkerHost({
    dataDir: path.join(root, "data"),
    machineDir
  });
  try {
    await callback(host);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("unopened catalog versions refresh before rename and delete", async () => {
  await withWorker(async (host) => {
    const writer = storyApiFromWorkerTransport(host.transport);
    const catalog = storyApiFromWorkerTransport(host.transport);
    const renameTarget = await writer.createStory("catalog rename");
    const deleteTarget = await writer.createStory("catalog delete");

    await catalog.listStories();
    await writer.renameStory(renameTarget.id, "writer revision");
    await writer.renameStory(deleteTarget.id, "delete revision");
    await catalog.listStories();

    await catalog.renameStory(renameTarget.id, "catalog revision");
    await catalog.deleteStory(deleteTarget.id);
  });
});

test("two worker facades hold opened story versions across reads and provider failure", async () => {
  await withWorker(async (host) => {
    const first = storyApiFromWorkerTransport(host.transport);
    const second = storyApiFromWorkerTransport(host.transport);
    const story = await first.createStory("held version");

    await second.loadStory(story.id);
    await first.renameStory(story.id, "writer A");
    await second.listStories();
    await expectRevisionConflict(
      second.renameStory(story.id, "writer B"),
      "catalog refresh must not advance an opened story"
    );
    await second.loadStory(story.id);
    await second.renameStory(story.id, "writer B");

    await first.loadStory(story.id);
    const root = await first.createNode(story.id, {
      parentId: null,
      text: "root"
    });
    const rootId = root.path.at(-1)?.id;
    assert.ok(rootId);
    const chapter = await first.createChapterBreak(story.id, rootId, "chapter");

    await second.loadStory(story.id);
    await first.renameStory(story.id, "writer C");
    await expectRevisionConflict(
      second.removeChapterBreak(story.id, chapter.breakId),
      "chapter preview must use the held version"
    );
    await second.loadStory(story.id);
    await second.removeChapterBreak(story.id, chapter.breakId);

    await first.loadStory(story.id);
    await second.renameStory(story.id, "writer D");
    await expectRevisionConflict(
      first.autonameStory(story.id),
      "autoname preflight must use the held version"
    );

    await second.loadStory(story.id);
    const settings = await second.getSettings();
    assert.equal(settings.editable, true);
    await second.saveSettings({
      transportOperationId: `integration:${createDurableMutationId()}`,
      mutationId: createDurableMutationId(),
      expectedStateGeneration: settings.stateGeneration,
      document: applyBasicSettingsDraft(settings.document, {
        ...settings.effective,
        provider: "openai-compatible",
        baseUrl: "https://127.0.0.1:1/v1",
        model: "missing",
        apiKeyEnv: null
      })
    });
    await assert.rejects(
      second.autonameStory(story.id),
      (error: unknown) => (error as { code?: unknown })?.code === "provider_failure"
    );

    await first.loadStory(story.id);
    await first.renameStory(story.id, "writer E");
    await expectRevisionConflict(
      second.renameStory(story.id, "writer F"),
      "provider failure must keep the held version"
    );
    await second.loadStory(story.id);
    await second.renameStory(story.id, "writer F");
  });
});

test("worker facade delivers follow-up payloads before advancing its held version", async () => {
  await withWorker(async (host) => {
    const api = storyApiFromWorkerTransport(host.transport);
    const story = await api.createStory("follow-up payload");
    const seeded = await api.createNode(story.id, {
      parentId: null,
      text: "Root prose for a dry run."
    });
    const node = seeded.path.at(-1);
    assert.ok(node);

    let rewritePayload: StoryPayload | null = null;
    const rewritten = await api.rewriteNode(
      story.id,
      node.id,
      {
        start: 0,
        end: 4,
        expected: "Root",
        instruction: "Rewrite this",
        attemptId: crypto.randomUUID()
      },
      () => {},
      new AbortController().signal,
      undefined,
      {
        onPayload: (payload) => {
          rewritePayload = payload;
          // Refuse adoption to prove the facade does not advance an unseen
          // confirming read.
          return false;
        }
      }
    );
    assert.ok(rewritten);
    assert.equal((rewritePayload as StoryPayload | null)?.id, story.id);
    await expectRevisionConflict(
      api.renameStory(story.id, "stale after rewrite"),
      "an unadopted rewrite payload must leave the held version unchanged"
    );
    await api.loadStory(story.id);
    await api.renameStory(story.id, "adopted rewrite");

    const current = await api.loadStory(story.id);
    const currentNode = current.path.find(({ id }) => id === node.id);
    assert.ok(currentNode);
    const expectedText = currentNode.text.slice(0, 4);
    const unobserved = await api.rewriteNode(
      story.id,
      node.id,
      {
        start: 0,
        end: expectedText.length,
        expected: expectedText,
        instruction: "Rewrite without a payload callback",
        attemptId: crypto.randomUUID()
      },
      () => {},
      new AbortController().signal
    );
    assert.ok(unobserved);
    await expectRevisionConflict(
      api.renameStory(story.id, "stale after unobserved rewrite"),
      "a follow-up payload without a callback must not advance the held version"
    );
    await api.loadStory(story.id);

    let summaryPayload: StoryPayload | null = null;
    const summary = await api.createSummaryTake(
      story.id,
      { nodeId: node.id },
      () => {},
      new AbortController().signal,
      {
        onPayload: (payload) => {
          summaryPayload = payload;
          return true;
        }
      }
    );
    assert.ok(summary);
    assert.equal((summaryPayload as StoryPayload | null)?.id, story.id);
    const switched = await api.switchLine(story.id, summary.nodeId, { stopAtNode: true });
    assert.equal(switched.path.at(-1)?.id, summary.nodeId);
  });
});
