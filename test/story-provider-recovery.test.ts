import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ProviderError } from "../server/errors.js";
import { parseStoryManifestBytes } from "../server/story-v6-codec.js";
import { StoryStore } from "../server/stories.js";
import {
  DELETE_MUTATION_ID,
  FINGERPRINT,
  hasServiceError,
  MUTATION_ID,
  requestFor,
  setup,
  STORY_ID,
  storyFixture,
  THIRD_MUTATION_ID
} from "./story-mutation-fixtures.js";

for (const cachedKind of ["v5", "v6"] as const) {
  test(`Q provider failure terminalizes after cached ${cachedKind.toUpperCase()} deletion`, async (t) => {
    const fixture = await setup(
      t,
      `1667-q-provider-failure-after-${cachedKind}-delete-`
    );
    let cachedVersion = {
      kind: "v5",
      manifestHash: fixture.v5Hash
    } as NonNullable<
      Awaited<ReturnType<StoryStore["loadVersioned"]>>["aggregateVersion"]
    >;
    if (cachedKind === "v6") {
      const upgraded = await fixture.mutations.runLocal(
        requestFor(THIRD_MUTATION_ID, "c".repeat(64), cachedVersion),
        "renameStory",
        (story) => { story.title = "Original V6"; }
      );
      cachedVersion = upgraded.aggregateVersion;
    }
    const operation = () => fixture.mutations.runProvider(
      requestFor(MUTATION_ID, FINGERPRINT, cachedVersion),
      "autonameStory",
      async (_stories, providerStarted) => {
        await providerStarted();
        await fixture.mutations.runDelete(requestFor(
          DELETE_MUTATION_ID,
          "d".repeat(64),
          cachedVersion
        ));
        throw new ProviderError("Rejected after deletion", 400);
      },
      storyFixture
    );

    await assert.rejects(operation(), ProviderError);
    const stored = await fixture.ledger.loadStoryReceipt(
      `story:${STORY_ID}`,
      MUTATION_ID
    );
    assert.equal(
      stored.prepared?.result.kind === "error"
        ? stored.prepared.result.code
        : null,
      "provider_failure"
    );
    const manifest = parseStoryManifestBytes(
      await readFile(fixture.manifestFile),
      STORY_ID
    );
    assert.equal(manifest.kind, "v6-deleted");
    if (manifest.kind !== "v6-deleted") assert.fail("Expected deleted V6");
    assert.equal(manifest.manifest.unresolvedProvider, null);
    await assert.rejects(operation(), hasServiceError("provider_failure"));
  });
}
