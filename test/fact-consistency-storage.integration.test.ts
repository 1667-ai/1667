import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hashFactConsistencyRun, type FactConsistencyRun } from "../shared/fact-consistency-types.js";
import { liveObjectIds } from "../server/story-format.js";
import { parseStoryManifestBytes, STORY_SCHEMA_VERSION_V16 } from "../server/story-v6-codec.js";
import { StoryStore } from "../server/stories.js";
import {
  providerOperation,
  request,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";

test("Fact consistency provider commit stores and reloads one content-addressed run", async (t) => {
  const fixture = await setup(t, "1667-fact-consistency-storage-");
  const run = factConsistencyRun();

  const committed = await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "checkFactConsistency",
    providerOperation(
      async (stories, providerStarted) => {
        await providerStarted();
        await stories.commitProviderEffect(STORY_ID, {
          kind: "fact-consistency",
          run
        });
        return run.runId;
      },
      () => run.runId
    )
  );

  const runHash = hashFactConsistencyRun(run);
  assert.equal(committed.value, run.runId);
  assert.equal(committed.story.factConsistencyRunId, runHash);
  assert.deepEqual(await fixture.stories.loadFactConsistencyRun(STORY_ID), run);

  const parsed = parseStoryManifestBytes(
    await readFile(fixture.manifestFile),
    STORY_ID
  );
  assert.equal(parsed.kind, "v16-live");
  if (parsed.kind !== "v16-live") return;
  assert.equal(parsed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V16);
  assert.equal(parsed.manifest.content.schemaVersion, 15);
  assert.equal(parsed.manifest.content.factConsistencyRunId, runHash);
  assert.deepEqual(liveObjectIds(parsed.manifest.content).leaves["fact-consistency"], [runHash]);

  const restarted = new StoryStore(path.join(fixture.dataDir, "stories"));
  await restarted.init();
  const loaded = await restarted.loadVersioned(STORY_ID);
  assert.equal(loaded.story.factConsistencyRunId, runHash);
  assert.deepEqual(await restarted.loadFactConsistencyRun(STORY_ID), run);
});

function factConsistencyRun(): FactConsistencyRun {
  return {
    format: "1667-fact-consistency-run",
    schemaVersion: 1,
    runId: "fact-run-1",
    scope: "story-line",
    anchor: { partId: "part-1", takeId: "part-1" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    provider: { profile: "utility", preset: "dry-run", model: "dry-run" },
    storyLineTakeIds: ["part-1"],
    parts: [{
      partId: "part-1",
      takeId: "part-1",
      findings: [{
        fact_id: "fact-1",
        quote: "green eyes",
        statement: "The Fact says blue eyes, but the prose says green eyes."
      }],
      droppedFindings: 0
    }],
    droppedFindings: 0
  };
}
