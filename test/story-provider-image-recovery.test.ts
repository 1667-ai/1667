import {
  MUTATION_ID,
  FINGERPRINT,
  FIXED_NOW,
  providerOperation,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { readDraftImageLease } from "../server/story-image-lease.js";
import {
  InjectedStoryMutationCrash,
  StoryMutationStore,
  type StoryMutationStoreHooks
} from "../server/story-mutation-store.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";

/**
 * Story and crash coverage for the receipt/pin/lease machinery an
 * image-bearing `continueStory` adds to `server/story-provider-mutation.ts`:
 * the ordered Image Object ids on the durable provider-started receipt
 * (settled decision D7), the pin that keeps the object readable for the
 * round trip, and consuming the Draft Lease only after the manifest and
 * receipt are durable. Modeled on test/story-provider-recovery.test.ts and
 * test/story-mutation-store.test.ts: reuse the same `dataDir` and construct
 * a NEW store instance to simulate a restart. `providerOperation`'s `work`
 * plays the part `server/generation-http.ts`'s `continueStory` normally
 * would: resolving a Draft Image and declaring it on the runtime, without
 * needing a real provider or a `supported` model capability.
 */

function imageEffect(attachment: StoryImageAttachment, genId = "gen-image-1") {
  return {
    kind: "continue" as const,
    parentId: null,
    appendTo: null,
    expectedTextHash: null,
    instruction: "Describe the attached image.",
    text: "A quiet room, lit by one lantern.",
    model: "test-model",
    genId,
    expectedParentActiveChildId: null,
    expectedAppendActiveChildId: null,
    expectedActiveRootId: null,
    expectedActiveLeafId: null,
    imageAttachments: [attachment]
  };
}

/** The exact steps `continueStory` performs around an image: resolve the
 *  Draft Lease into an attachment, declare it on the runtime before the
 *  provider starts, then commit with it attached to the new take. */
async function runImageContinuation(
  stories: ProviderStoryRuntime<"continueStory">,
  providerStarted: () => Promise<void>,
  attachment: StoryImageAttachment,
  leaseId: string,
  genId = "gen-image-1"
) {
  stories.declareImageResolution?.([attachment.objectId], [leaseId]);
  await providerStarted();
  return await stories.commitProviderEffect(STORY_ID, imageEffect(attachment, genId));
}

test("an image continuation puts ordered Image Object ids on the STARTED receipt, and consumes the Draft Lease only once the manifest and receipt are durable", async (t) => {
  const fixture = await setup(t, "1667-q-image-receipt-");
  const staged = await fixture.stories.stageImage(STORY_ID, {
    mediaType: "image/png",
    width: 4,
    height: 4,
    bytes: Buffer.from("receipt-image")
  });
  const attachment = await fixture.stories.resolveDraftImage(STORY_ID, {
    leaseId: staged.leaseId,
    objectId: staged.attachment.objectId
  });

  let sawStartedImageIds: readonly string[] | undefined;
  const committed = await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
    "continueStory",
    providerOperation(async (stories, providerStarted) => {
      stories.declareImageResolution?.([attachment.objectId], [staged.leaseId]);
      await providerStarted();
      // The STARTED record is durable by the time providerStarted resolves.
      // Read it back directly, before the take itself commits.
      const receipt = await fixture.ledger.loadStoryReceipt(`story:${STORY_ID}`, MUTATION_ID);
      sawStartedImageIds = receipt.started?.imageObjectIds;
      // The lease must still be live mid-flight: nothing has consumed it yet.
      assert.notEqual(await readDraftImageLease(fixture.dataDir + "/stories/" + STORY_ID, staged.leaseId), null);
      return await stories.commitProviderEffect(STORY_ID, imageEffect(attachment));
    }, () => null)
  );

  assert.deepEqual(sawStartedImageIds, [attachment.objectId]);
  const committedNode = committed.story.nodes.find((node) => node.genId === "gen-image-1");
  assert.deepEqual(committedNode?.imageAttachments, [attachment]);
  assert.equal(
    await readDraftImageLease(fixture.dataDir + "/stories/" + STORY_ID, staged.leaseId),
    null,
    "the Draft Lease must be gone once the commit above returned"
  );
});

test("a provider failure after the STARTED receipt leaves the Draft Lease in place for a safe retry", async (t) => {
  const fixture = await setup(t, "1667-q-image-failure-");
  const staged = await fixture.stories.stageImage(STORY_ID, {
    mediaType: "image/png",
    width: 4,
    height: 4,
    bytes: Buffer.from("failure-image")
  });
  const attachment = await fixture.stories.resolveDraftImage(STORY_ID, {
    leaseId: staged.leaseId,
    objectId: staged.attachment.objectId
  });

  const { ProviderError } = await import("../server/errors.js");
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
      "continueStory",
      providerOperation(async (stories, providerStarted) => {
        stories.declareImageResolution?.([attachment.objectId], [staged.leaseId]);
        await providerStarted();
        throw new ProviderError("The model refused the image.", 400);
      }, () => null)
    ),
    (error: unknown) => error instanceof ProviderError
  );

  assert.notEqual(
    await readDraftImageLease(fixture.dataDir + "/stories/" + STORY_ID, staged.leaseId),
    null,
    "a failed generation must never consume the Draft Lease it never committed"
  );
});

test("one provider mutation id causes at most one provider call, even with an image attached", async (t) => {
  const fixture = await setup(t, "1667-q-image-once-");
  const staged = await fixture.stories.stageImage(STORY_ID, {
    mediaType: "image/png",
    width: 4,
    height: 4,
    bytes: Buffer.from("once-image")
  });
  const attachment = await fixture.stories.resolveDraftImage(STORY_ID, {
    leaseId: staged.leaseId,
    objectId: staged.attachment.objectId
  });

  let providerCalls = 0;
  const run = () => fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
    "continueStory",
    providerOperation(async (stories, providerStarted) => {
      providerCalls += 1;
      return await runImageContinuation(stories, providerStarted, attachment, staged.leaseId);
    }, () => null)
  );

  const first = await run();
  const second = await run();
  assert.equal(providerCalls, 1, "the second call with the same mutation id must replay, not re-invoke the provider");
  assert.equal(second.story.updatedAt, first.story.updatedAt);
  // The image itself attaches on the live commit `first` returns. In this
  // release the successor story schema stays inactive
  // (shared/image-input-release.ts), so a manifest re-decode, which is
  // exactly what a replay reads back, never carries `imageAttachments`
  // forward. Only the in-memory result of the commit that actually attached
  // it does. That is a deliberate, documented consequence of the two-step
  // schema release, not a defect in replay.
  const committedNode = first.story.nodes.find((node) => node.genId === "gen-image-1");
  assert.deepEqual(committedNode?.imageAttachments, [attachment]);
});

test("crash after manifest publish leaves the Draft Lease unconsumed; the story commit itself survives and never replays a second provider call", async (t) => {
  let injected = false;
  const hooks: StoryMutationStoreHooks = {
    afterPublish: () => {
      if (injected) return;
      injected = true;
      throw new InjectedStoryMutationCrash("publish");
    }
  };
  const fixture = await setup(t, "1667-q-image-crash-publish-", hooks);
  const staged = await fixture.stories.stageImage(STORY_ID, {
    mediaType: "image/png",
    width: 4,
    height: 4,
    bytes: Buffer.from("crash-publish-image")
  });
  const attachment = await fixture.stories.resolveDraftImage(STORY_ID, {
    leaseId: staged.leaseId,
    objectId: staged.attachment.objectId
  });

  let providerCalls = 0;
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
      "continueStory",
      providerOperation(async (stories, providerStarted) => {
        providerCalls += 1;
        return await runImageContinuation(stories, providerStarted, attachment, staged.leaseId);
      }, () => null)
    ),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );
  assert.equal(providerCalls, 1);
  // The manifest rename already completed before the injected crash fired,
  // so the take is durably committed even though this attempt never
  // returned. This is exactly the "crash after manifest replacement" case.
  // The Draft Lease consumption step never ran, so the lease survives.
  assert.notEqual(
    await readDraftImageLease(fixture.dataDir + "/stories/" + STORY_ID, staged.leaseId),
    null,
    "a crash between manifest publish and lease removal must leave the lease in place"
  );

  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  const replayed = await recovered.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
    "continueStory",
    providerOperation(async () => {
      providerCalls += 1;
      throw new Error("a replayed terminal outcome must never re-invoke the provider");
    }, () => null)
  );
  assert.equal(providerCalls, 1, "recovery must replay the already-committed result, not run the provider again");
  // See the note in the "at most one provider call" test above: a replay
  // reads the manifest back from disk, which never carries
  // `imageAttachments` while the successor schema stays inactive. The
  // committed take itself is correct either way. `replayed.result` names
  // the same story revision the live commit produced.
  assert.equal(replayed.story.nodes.some((node) => node.genId === "gen-image-1"), true);
});

test("crash before the provider ever started leaves no durable trace at all; the Draft Lease is untouched and the retry runs the provider exactly once", async (t) => {
  const fixture = await setup(t, "1667-q-image-crash-early-");
  const staged = await fixture.stories.stageImage(STORY_ID, {
    mediaType: "image/png",
    width: 4,
    height: 4,
    bytes: Buffer.from("crash-early-image")
  });
  const attachment = await fixture.stories.resolveDraftImage(STORY_ID, {
    leaseId: staged.leaseId,
    objectId: staged.attachment.objectId
  });
  const bundleLeases = fixture.dataDir + "/stories/" + STORY_ID;

  let providerCalls = 0;
  await assert.rejects(
    fixture.mutations.runProviderOperation(
      requestFor(MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
      "continueStory",
      providerOperation(async (stories) => {
        providerCalls += 1;
        // Simulate a crash while resolving/declaring the image, strictly
        // before `providerStarted()`. Nothing about this mutation has
        // touched the ledger or the manifest yet, so it must leave no trace
        // at all: "a crash before manifest commit keeps the lease and Image
        // Object available for safe retry" (image-input design).
        stories.declareImageResolution?.([attachment.objectId], [staged.leaseId]);
        throw new Error("simulated crash before providerStarted");
      }, () => null)
    ),
    /simulated crash before providerStarted/
  );
  assert.equal(providerCalls, 1);
  assert.notEqual(
    await readDraftImageLease(bundleLeases, staged.leaseId),
    null,
    "a crash before any provider bytes were requested must leave the Draft Lease untouched"
  );

  const committed = await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
    "continueStory",
    providerOperation(async (stories, providerStarted) => {
      providerCalls += 1;
      return await runImageContinuation(stories, providerStarted, attachment, staged.leaseId);
    }, () => null)
  );
  assert.equal(providerCalls, 2, "nothing durable existed before the crash, so the retry is a fresh attempt");
  const committedNode = committed.story.nodes.find((node) => node.genId === "gen-image-1");
  assert.deepEqual(committedNode?.imageAttachments, [attachment]);
  assert.equal(
    await readDraftImageLease(bundleLeases, staged.leaseId),
    null,
    "the successful retry's own commit must consume the lease"
  );
});
