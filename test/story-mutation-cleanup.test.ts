import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hashStoryV5ManifestBytes } from "../server/story-manifest-hash.js";
import { cleanupPending } from "../server/story-cleanup.js";
import { createTake, newNode, switchLine } from "../server/story-nodes.js";
import { StoryObjectStore } from "../server/story-objects.js";
import { parseStoryManifestBytes } from "../server/story-v6-codec.js";
import { StoryStore } from "../server/stories.js";
import {
  FINGERPRINT,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";

const SEED_MUTATION_ID = "m1.1767225600000.aa00000000000000000000000000000a";
const SWITCH_MUTATION_ID = "m1.1767225600000.aa00000000000000000000000000000b";
const EDIT_MUTATION_ID = "m1.1767225600000.aa00000000000000000000000000000c";
const LEGACY_MUTATION_ID = "m1.1767225600000.aa00000000000000000000000000000d";

test("Q cleanup intent tracks dropped references: a take switch sweeps nothing, an edit reaps its old revision", async (t) => {
  let sweeps = 0;
  let bundleDir = "";
  let markerAtStage: boolean | null = null;
  const fixture = await setup(
    t,
    "1667-q-cleanup-refs-",
    {
      afterStage: async () => {
        markerAtStage = await cleanupPending(bundleDir);
      }
    },
    (storiesDir) => new StoryStore(storiesDir, async (dir, liveRevisionIds, signal) => {
      sweeps += 1;
      return await new StoryObjectStore(dir).sweep(liveRevisionIds, signal);
    })
  );
  bundleDir = path.dirname(fixture.manifestFile);

  // Seed two takes of the same seam through the receipt-backed path. The
  // second take ends up active, so the later switch is a real change.
  const seeded = await fixture.mutations.runLocal(
    requestFor(SEED_MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: fixture.v5Hash }),
    "createNode",
    (story) => {
      createTake(story, newNode(null, "Open", "The first take.", "test", { id: "take-one" }));
      createTake(story, newNode(null, "Open", "The second take.", "test", { id: "take-two" }));
    }
  );
  // Additive object writes publish sweep intent before the objects, then
  // retire it at publish time because nothing was dropped.
  assert.equal(markerAtStage, true);
  await fixture.stories.waitForMaintenance();
  assert.equal(sweeps, 0);
  assert.equal(await cleanupPending(bundleDir), false);

  // A take switch drops no object references: no cleanup intent is ever
  // published, and no sweep runs.
  markerAtStage = null;
  const switched = await fixture.mutations.runLocal(
    requestFor(SWITCH_MUTATION_ID, FINGERPRINT, seeded.aggregateVersion),
    "switchLine",
    (story) => {
      switchLine(story, "take-one");
    }
  );
  assert.equal(switched.story.activeRootId, "take-one");
  assert.equal(markerAtStage, false);
  await fixture.stories.waitForMaintenance();
  assert.equal(sweeps, 0);
  assert.equal(await cleanupPending(bundleDir), false);

  // An edit drops the replaced revision: cleanup intent must be durable
  // before the manifest that drops it publishes, and the sweep must remove
  // the orphaned object afterwards.
  const beforeEdit = parseStoryManifestBytes(await readFile(fixture.manifestFile), STORY_ID);
  if (beforeEdit.kind !== "v6-live") assert.fail("Expected a live V6 manifest");
  const oldRevisionId = beforeEdit.manifest.content.nodes
    .find((node) => node.id === "take-one")!.revisionId;
  markerAtStage = null;
  await fixture.mutations.runLocal(
    requestFor(EDIT_MUTATION_ID, FINGERPRINT, switched.aggregateVersion),
    "editNode",
    (story) => {
      story.nodes.find((node) => node.id === "take-one")!.text = "The first take, rewritten.";
    }
  );
  assert.equal(markerAtStage, true);
  await fixture.stories.waitForMaintenance();
  assert.ok(sweeps >= 1, "dropping a revision must schedule a sweep");
  assert.equal(await cleanupPending(bundleDir), false);
  await assert.rejects(
    readFile(new StoryObjectStore(bundleDir).objectPath("revisions", oldRevisionId)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    "the replaced revision must be reaped"
  );
});

test("Q legacy-schema source keeps its sweep obligation through the V6 session", async (t) => {
  let sweeps = 0;
  let bundleDir = "";
  let markerAtStage: boolean | null = null;
  const fixture = await setup(
    t,
    "1667-q-cleanup-legacy-",
    {
      afterStage: async () => {
        markerAtStage = await cleanupPending(bundleDir);
      }
    },
    (storiesDir) => new StoryStore(storiesDir, async (dir, liveRevisionIds, signal) => {
      sweeps += 1;
      return await new StoryObjectStore(dir).sweep(liveRevisionIds, signal);
    })
  );
  bundleDir = path.dirname(fixture.manifestFile);

  // Downgrade the stored manifest to schema 4. Parsing upgrades it in memory,
  // so objects an older schema hid are invisible to the reference diff.
  const manifest = JSON.parse(await readFile(fixture.manifestFile, "utf8")) as Record<string, unknown>;
  manifest.schemaVersion = 4;
  delete manifest.chapterBreaks;
  delete manifest.autonameId;
  await writeFile(fixture.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const legacyHash = hashStoryV5ManifestBytes(await readFile(fixture.manifestFile));

  // A resident object no manifest references stands in for the states the
  // legacy schema dropped during normalization.
  const objects = new StoryObjectStore(bundleDir);
  const obsoleteRevisionId = await objects.storeText("An obsolete legacy fact state.");
  await objects.flush();

  // Metadata-only migration mutation: no reference diff, no object writes.
  await fixture.mutations.runLocal(
    requestFor(LEGACY_MUTATION_ID, FINGERPRINT, { kind: "v5", manifestHash: legacyHash }),
    "renameStory",
    (story) => {
      story.title = "Migrated";
    }
  );
  assert.equal(markerAtStage, true, "a legacy source must publish sweep intent");
  await fixture.stories.waitForMaintenance();
  assert.ok(sweeps >= 1, "a legacy source must sweep after commit");
  assert.equal(await cleanupPending(bundleDir), false);
  await assert.rejects(
    readFile(objects.objectPath("revisions", obsoleteRevisionId)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    "objects the legacy schema hid must be reaped"
  );
});
