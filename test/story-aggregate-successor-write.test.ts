import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeStoryBundle } from "../server/story-codec.js";
import { StoryObjectStore } from "../server/story-objects.js";
import {
  formatV6,
  parseStoryManifestBytes,
  STORY_SCHEMA_VERSION_V6,
  STORY_SCHEMA_VERSION_V8
} from "../server/story-v6-codec.js";
import { hashStoryV6ManifestBytes } from "../server/story-manifest-hash.js";
import { StoryStore } from "../server/stories.js";
import type { StoryManifestV6 } from "../server/story-v6-types.js";
import type { StoryImageAttachment } from "../shared/image-attachment.js";
import {
  FIXED_NOW,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  providerOperation,
  request,
  requestFor,
  setup,
  STORY_ID,
  storyFixture
} from "./story-mutation-fixtures.js";

/**
 * G12: the production commit path (`StoryAggregateSession`, `reduceStoryV6`)
 * must be able to write the successor (V8) story envelope when, and only
 * when, `resolveImageInputActivation()` resolves true for that write.
 *
 * Coverage:
 * - activation off: a full Continue commit is byte-identical to the current
 *   V6-envelope-of-V5-content shape (proven by hash, not only by structure).
 * - activation on: a Continue that carries an Image Attachment commits as a
 *   V8 envelope, and a fresh store instance over the same data directory
 *   reads the attachment back.
 * - activation on: a story with no Image Attachment stays at V6.
 */

function attachment(objectId: string): StoryImageAttachment {
  return { objectId, mediaType: "image/png", width: 4, height: 4, byteLength: 18 };
}

async function storeTestImage(storiesDir: string, label: string): Promise<StoryImageAttachment> {
  const objects = new StoryObjectStore(`${storiesDir}/${STORY_ID}`);
  await objects.init();
  const objectId = await objects.storeImage(Buffer.from(`fixture-image-${label}`, "utf8"));
  await objects.flush();
  return attachment(objectId);
}

test("Q activation off: a full Continue commit writes byte-identical V6 manifest bytes", async (t) => {
  const fixture = await setup(t, "1667-q-successor-off-bytes-");
  const commit = await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "continueStory",
    providerOperation(
      async (stories, providerStarted) => {
        await providerStarted();
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "continue",
          parentId: null,
          appendTo: null,
          expectedTextHash: null,
          instruction: "Describe the room.",
          text: "A quiet room.",
          model: "test",
          genId: "g-plain",
          expectedParentActiveChildId: null,
          expectedAppendActiveChildId: null,
          expectedActiveRootId: null,
          expectedActiveLeafId: null
        });
      },
      storyFixture
    )
  );
  assert.equal(commit.story.nodes.length, 1);

  const afterBytes = await readFile(fixture.manifestFile);
  const parsed = parseStoryManifestBytes(afterBytes, STORY_ID);
  assert.equal(parsed.kind, "v6-live");
  if (parsed.kind !== "v6-live") return;
  assert.equal(parsed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V6);
  assert.equal(parsed.manifest.content.schemaVersion, 5);
  // Structural proof that no successor field leaked through: the string
  // never appears anywhere in the canonical bytes.
  assert.ok(!afterBytes.toString("utf8").includes("imageAttachments"));

  // Byte proof: independently re-derive the V5 content payload through the
  // exact functions this release always used (`encodeStoryBundle`'s 2-arg
  // overload and `formatV6`, neither touched by this change) and assert the
  // reconstruction is byte-for-byte identical to what the production commit
  // path actually wrote. Any drift in either the content or the envelope
  // would break this equality.
  const reference = new StoryObjectStore(`${fixture.dataDir}/stories/${STORY_ID}`);
  await reference.init();
  const referenceContent = await encodeStoryBundle(commit.story, reference);
  const referenceManifest: StoryManifestV6 = { ...parsed.manifest, content: referenceContent };
  const referenceBytes = Buffer.from(formatV6(referenceManifest), "utf8");
  assert.deepEqual(referenceBytes, afterBytes);
  assert.equal(
    hashStoryV6ManifestBytes(referenceBytes),
    hashStoryV6ManifestBytes(afterBytes)
  );
});

test("Q activation on: a Continue carrying an Image Attachment commits as V8, and a fresh store reads it back", async (t) => {
  const fixture = await setup(
    t,
    "1667-q-successor-on-images-",
    {},
    undefined,
    { imageInputActivation: true }
  );
  const image = await storeTestImage(`${fixture.dataDir}/stories`, "one");

  const commit = await fixture.mutations.runProviderOperation(
    request(fixture.v5Hash),
    "continueStory",
    providerOperation(
      async (stories, providerStarted) => {
        await providerStarted();
        return await stories.commitProviderEffect(STORY_ID, {
          kind: "continue",
          parentId: null,
          appendTo: null,
          expectedTextHash: null,
          instruction: "Describe the image.",
          text: "A lantern-lit room.",
          model: "test",
          genId: "g-images",
          expectedParentActiveChildId: null,
          expectedAppendActiveChildId: null,
          expectedActiveRootId: null,
          expectedActiveLeafId: null,
          imageAttachments: [image]
        });
      },
      storyFixture
    )
  );
  assert.deepEqual(commit.story.nodes[0]?.imageAttachments, [image]);

  const afterBytes = await readFile(fixture.manifestFile);
  const parsed = parseStoryManifestBytes(afterBytes, STORY_ID);
  assert.equal(parsed.kind, "v8-live");
  if (parsed.kind !== "v8-live") return;
  assert.equal(parsed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V8);
  assert.equal(parsed.manifest.content.schemaVersion, 7);
  assert.deepEqual(parsed.manifest.content.nodes[0]?.imageAttachments, [image]);

  // A restart is a new store instance over the same data directory, never a
  // new session inside the same one. Reading, not mutating, is what "reads
  // those attachments back" needs.
  const reopened = new StoryStore(`${fixture.dataDir}/stories`);
  const reloaded = await reopened.loadVersioned(STORY_ID);
  assert.deepEqual(reloaded.story.nodes[0]?.imageAttachments, [image]);
});

test("Q activation on: a story with no Image Attachment stays at V6", async (t) => {
  const fixture = await setup(
    t,
    "1667-q-successor-on-no-images-",
    {},
    undefined,
    { imageInputActivation: true }
  );
  const first = await fixture.mutations.runLocal(
    request(fixture.v5Hash),
    "createNode",
    (story) => {
      story.nodes.push({
        id: "plain-take",
        parentId: null,
        instruction: "Describe the room.",
        text: "A quiet room, nothing more.",
        model: "test",
        createdAt: FIXED_NOW.toISOString(),
        activeChildId: null
      });
      story.activeRootId = "plain-take";
    }
  );
  assert.equal(first.story.nodes[0]?.imageAttachments, undefined);

  const afterBytes = await readFile(fixture.manifestFile);
  const parsed = parseStoryManifestBytes(afterBytes, STORY_ID);
  assert.equal(parsed.kind, "v6-live");
  if (parsed.kind !== "v6-live") return;
  assert.equal(parsed.manifest.schemaVersion, STORY_SCHEMA_VERSION_V6);
  assert.equal(parsed.manifest.content.schemaVersion, 5);
  assert.ok(!afterBytes.toString("utf8").includes("imageAttachments"));
  // Let the first mutation's background object sweep settle before the
  // second one starts, so the two do not race over the same story.
  await fixture.stories.waitForMaintenance();

  // A second local mutation, still activation on, still no attachment: the
  // story must not "creep" onto the successor schema just because the
  // switch is on somewhere in its history.
  const second = await fixture.mutations.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, first.aggregateVersion),
    "editNode",
    (story) => {
      const node = story.nodes.find((candidate) => candidate.id === "plain-take");
      if (node !== undefined) node.text = "A quiet room, edited.";
    }
  );
  assert.equal(second.aggregateVersion.kind, "v6");
  const finalBytes = await readFile(fixture.manifestFile);
  const finalParsed = parseStoryManifestBytes(finalBytes, STORY_ID);
  assert.equal(finalParsed.kind, "v6-live");
});
