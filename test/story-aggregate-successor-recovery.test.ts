import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import {
  InjectedStoryMutationCrash,
  StoryMutationStore,
  type StoryMutationStoreHooks
} from "../server/story-mutation-store.js";
import { StoryObjectStore } from "../server/story-objects.js";
import {
  parseStoryManifestBytes,
  STORY_SCHEMA_VERSION_V6,
  STORY_SCHEMA_VERSION_V8
} from "../server/story-v6-codec.js";
import { StoryStore } from "../server/stories.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import type { Story } from "../shared/types.js";
import {
  FIXED_NOW,
  hasServiceError,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  request,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";

/**
 * G12, the rest of the required coverage: recovery from a crash staged
 * between the manifest replacement and its publish, for both envelope
 * versions, and the predecessor refusal: a build that resolves activation
 * off must still refuse every mutation once a story has already reached V8,
 * even though this release's own default resolves activation on.
 */

function attachment(objectId: string): StoryImageAttachment {
  return { objectId, mediaType: "image/png", width: 3, height: 3, byteLength: 21 };
}

async function storeTestImage(storiesDir: string, label: string): Promise<StoryImageAttachment> {
  const objects = new StoryObjectStore(`${storiesDir}/${STORY_ID}`);
  await objects.init();
  const objectId = await objects.storeImage(Buffer.from(`fixture-image-${label}`, "utf8"));
  await objects.flush();
  return attachment(objectId);
}

function crashAfterPrepared(): StoryMutationStoreHooks {
  let injected = false;
  return {
    afterPrepared: () => {
      if (injected) return;
      injected = true;
      // Staged (`.next` written) and ledger-durable (the prepared record is
      // written immediately before this hook), but not yet published: the
      // exact window "crash between staging and publishing" names.
      throw new InjectedStoryMutationCrash("prepared");
    }
  };
}

test("Q crash between staging and publishing recovers a V6 replacement", async (t) => {
  const fixture = await setup(t, "1667-q-successor-recovery-v6-", crashAfterPrepared());
  const addTake = (story: Story): void => {
    story.nodes.push({
      id: "recovered-take",
      parentId: null,
      instruction: "Describe the room.",
      text: "A quiet room.",
      model: "test",
      createdAt: FIXED_NOW.toISOString(),
      activeChildId: null
    });
    story.activeRootId = "recovered-take";
  };
  await assert.rejects(
    fixture.mutations.runLocal(request(fixture.v5Hash), "createNode", addTake),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

  // The staged replacement and its ledger evidence are the only residue: the
  // manifest pointer never moved, so this transaction never became visible.
  await access(`${fixture.manifestFile}.next`);
  assert.equal(
    parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID).kind,
    "v5"
  );

  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW }
  );
  await recovered.init();
  // A transaction staged and ledger-prepared but never published never took
  // effect, so recovery discards the torn residue and the same mutation ID
  // retries from scratch, not a replay of a result that was never visible.
  const replay = await recovered.runLocal(request(fixture.v5Hash), "createNode", addTake);
  assert.equal(replay.story.nodes[0]?.id, "recovered-take");
  assert.equal(replay.aggregateVersion.kind, "v6");

  const finalBytes = await readFile(fixture.manifestFile);
  const finalParsed = parseStoryManifestBytes(finalBytes, STORY_ID);
  assert.equal(finalParsed.kind, "v6-live");
  if (finalParsed.kind !== "v6-live") return;
  assert.equal(finalParsed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V6);
});

test("Q crash between staging and publishing recovers a V8 replacement", async (t) => {
  const fixture = await setup(
    t,
    "1667-q-successor-recovery-v8-",
    crashAfterPrepared(),
    undefined,
    { imageInputActivation: true }
  );
  const image = await storeTestImage(`${fixture.dataDir}/stories`, "recovery");
  const addImageTake = (story: Story): void => {
    story.nodes.push({
      id: "recovered-image-take",
      parentId: null,
      instruction: "Describe the image.",
      text: "A lantern-lit room.",
      model: "test",
      createdAt: FIXED_NOW.toISOString(),
      activeChildId: null,
      imageAttachments: [image]
    });
    story.activeRootId = "recovered-image-take";
  };
  await assert.rejects(
    fixture.mutations.runLocal(request(fixture.v5Hash), "createNode", addImageTake),
    (error: unknown) => error instanceof InjectedStoryMutationCrash
  );

  await access(`${fixture.manifestFile}.next`);
  assert.equal(
    parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID).kind,
    "v5"
  );

  const recovered = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW, imageInputActivation: true }
  );
  await recovered.init();
  // Same reasoning as the V6 case above: the crash predates publish, so
  // recovery discards the torn V8 stage and this retry builds a fresh one.
  const replay = await recovered.runLocal(request(fixture.v5Hash), "createNode", addImageTake);
  assert.deepEqual(replay.story.nodes[0]?.imageAttachments, [image]);
  assert.equal(replay.aggregateVersion.kind, "v6");

  const finalBytes = await readFile(fixture.manifestFile);
  const finalParsed = parseStoryManifestBytes(finalBytes, STORY_ID);
  assert.equal(finalParsed.kind, "v8-live");
  if (finalParsed.kind !== "v8-live") return;
  assert.equal(finalParsed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V8);
  assert.deepEqual(finalParsed.manifest.content.nodes[0]?.imageAttachments, [image]);
});

test("Q activation off: a V8 document still refuses every mutation and still reads", async (t) => {
  const fixture = await setup(
    t,
    "1667-q-successor-refusal-",
    {},
    undefined,
    { imageInputActivation: true }
  );
  const image = await storeTestImage(`${fixture.dataDir}/stories`, "refusal");
  await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "createNode",
    (story) => {
      story.nodes.push({
        id: "sealed-take",
        parentId: null,
        instruction: "Describe the image.",
        text: "A lantern-lit room.",
        model: "test",
        createdAt: FIXED_NOW.toISOString(),
        activeChildId: null,
        imageAttachments: [image]
      });
      story.activeRootId = "sealed-take";
    }
  );
  const beforeBytes = await readFile(fixture.manifestFile);
  assert.equal(parseStoryManifestBytes(beforeBytes, STORY_ID).kind, "v8-live");

  // A later process that resolves activation off, a genuine predecessor: the
  // successor document it did not just create in this session must still
  // refuse every mutation. This build's own release default is on, so the
  // override is explicit here, the same way a rollback-safety test overrides
  // it everywhere else in this suite.
  const sealed = new StoryMutationStore(
    fixture.stories,
    createMutationCoordinator(),
    fixture.dataDir,
    { ledger: fixture.ledger, now: () => FIXED_NOW, imageInputActivation: false }
  );
  await sealed.init();
  await assert.rejects(
    sealed.runLocal(
      requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, { kind: "v6", revision: "00000000000000000002" }),
      "createNode",
      () => assert.fail("a V8 document must refuse mutation before this runs")
    ),
    hasServiceError("story_manifest_requires_successor")
  );

  const afterBytes = await readFile(fixture.manifestFile);
  assert.deepEqual(afterBytes, beforeBytes);

  const reopened = new StoryStore(`${fixture.dataDir}/stories`);
  const reloaded = await reopened.loadVersioned(STORY_ID);
  assert.deepEqual(reloaded.story.nodes[0]?.imageAttachments, [image]);
});
