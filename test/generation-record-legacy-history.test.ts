import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ServiceError } from "../server/errors.js";
import { StoryStore } from "../server/stories.js";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * Legacy JSON stories predate Generation Records and stay readable without a
 * migration write (see server/story-storage-reader.ts). A real legacy take
 * has no records to list — that is a supported empty history, not a missing
 * take — while a node id the legacy story never had must still 404. See
 * server/stories.ts's `requireGenerationRecordNode`.
 */
test("Generation Record summaries: a real legacy take has empty history, an unknown take still 404s", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "1667-generation-record-legacy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stories = new StoryStore(dir);
  await stories.init();

  const legacyId = "legacy-story";
  await writeFile(path.join(dir, `${legacyId}.json`), JSON.stringify({
    id: legacyId,
    title: "Legacy",
    createdAt: NOW,
    updatedAt: NOW,
    parts: [{
      id: "p1",
      instruction: "Go",
      text: "Written before Generation Records existed.",
      model: "m",
      createdAt: NOW
    }]
  }));

  const summaries = await stories.loadGenerationRecordSummaries(legacyId, "p1");
  assert.deepEqual(summaries, []);

  await assert.rejects(
    stories.loadGenerationRecordSummaries(legacyId, "no-such-node"),
    (error: unknown) => error instanceof ServiceError && error.status === 404
  );
});
