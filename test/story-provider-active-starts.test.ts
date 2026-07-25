import assert from "node:assert/strict";
import test from "node:test";
import type { StoryAggregateSession } from "../server/story-aggregate-session.js";
import type { StoryAggregateSnapshot } from "../server/story-aggregate-state.js";
import { ActiveProviderStarts } from "../server/story-provider-active-starts.js";
import type { StoryStore } from "../server/stories.js";

test("releasing a provider snapshot forgets its predecessor exactly once", () => {
  let snapshotReleases = 0;
  const stories = {
    pinProviderSnapshot: () => () => {
      snapshotReleases += 1;
    }
  } as unknown as StoryStore;
  const snapshot = {
    storageKind: "v6",
    manifest: { revision: "7" }
  } as StoryAggregateSnapshot;
  const session = {
    storyId: "story-1",
    snapshot
  } as StoryAggregateSession;
  const starts = new ActiveProviderStarts();

  const releaseWinner = starts.pinSnapshot(stories, session, "mutation-1");
  const releaseDuplicate = starts.pinSnapshot(stories, session, "mutation-1");
  starts.remember("story-1", "mutation-1", snapshot);
  assert.deepEqual(
    starts.predecessor("story-1", "mutation-1"),
    { kind: "v6", revision: "7" }
  );

  releaseDuplicate();
  releaseDuplicate();
  assert.deepEqual(
    starts.predecessor("story-1", "mutation-1"),
    { kind: "v6", revision: "7" }
  );
  assert.equal(snapshotReleases, 1);

  releaseWinner();
  releaseWinner();

  assert.equal(starts.predecessor("story-1", "mutation-1"), null);
  assert.equal(snapshotReleases, 2);
});
