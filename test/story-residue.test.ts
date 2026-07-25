import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../server/canonical-json.js";
import {
  serializeManifest,
  StoryFormatError,
  type StoryManifestV5
} from "../server/story-format.js";
import { reapEphemeralBundles, stagingBundlePath } from "../server/story-lifecycle.js";
import {
  classifyStoryEntry,
  formatStoryResidueIdentity,
  isStoryId,
  legacyStoryResidueNames,
  MAX_STORY_RESIDUE_IDENTITY_BYTES,
  parseStoryResidueIdentityBytes,
  storyResidueIdentityName,
  storyResidueIdentityTempName,
  storyResidueNames,
  storyResidueToken,
  type StoryDirectoryEntry
} from "../server/story-residue.js";
import { storyIdForMutation } from "../server/story-identity.js";
import { StoryStore } from "../server/stories.js";

const MUTATION_ID = "m1.1767225600000.0123456789abcdef0123456789abcdef";
const SECOND_MUTATION_ID = "m1.1767225600001.0123456789abcdef0123456789abcdef";
const DERIVED_ID = `st1_${"a".repeat(52)}`;
const CREATE_STORY_ID = storyIdForMutation(MUTATION_ID);
const SECOND_CREATE_STORY_ID = storyIdForMutation(SECOND_MUTATION_ID);

test("story residue: story IDs admit bounded legacy IDs and exact derived IDs", () => {
  assert.equal(isStoryId("a"), true);
  assert.equal(isStoryId("A".repeat(255)), true);
  assert.equal(isStoryId("a".repeat(256)), false);
  assert.equal(isStoryId(DERIVED_ID), true);
  assert.equal(isStoryId(`st1_${"a".repeat(51)}`), false);
  assert.equal(isStoryId(`st1_${"a".repeat(53)}`), false);
  assert.equal(isStoryId(`st1_${"A".repeat(52)}`), false);
  assert.equal(isStoryId(`st1_${"0".repeat(52)}`), false);
  assert.equal(isStoryId(`st1_${"a".repeat(51)}b`), false, "unused Base32 bits must be zero");
  assert.equal(isStoryId(`st1_${"a".repeat(51)}q`), true);
});

test("story residue: catalog classification separates canonical stories and unrelated entries", () => {
  assert.deepEqual(classifyStoryEntry(entry("legacy-story", true)), {
    kind: "canonical-story",
    storyId: "legacy-story"
  });
  assert.deepEqual(classifyStoryEntry(entry(DERIVED_ID, true)), {
    kind: "canonical-story",
    storyId: DERIVED_ID
  });
  assert.deepEqual(classifyStoryEntry(entry("legacy-story.json", false)), { kind: "unrelated" });
  assert.deepEqual(classifyStoryEntry(entry(".DS_Store", false)), { kind: "unrelated" });
  assert.deepEqual(classifyStoryEntry(entry(`st1_${"a".repeat(51)}`, true)), { kind: "unrelated" });
});

test("story residue: canonical create and reap names are bounded, hashed, and typed", () => {
  const names = storyResidueNames(DERIVED_ID);
  assert.deepEqual(names, {
    create: ".1667-story-create-h1_c6013a4eac7b82afe53a4f5c22d727a2fae31356fbac9961680cc5eb9363a94e",
    reap: ".1667-story-reap-h1_407bb8182cfcb4dc72fcabddbd50bac82a03d4f70b9d7b821fe72988feba9b77"
  });
  assert.deepEqual(classifyStoryEntry(entry(names.create, true)), {
    kind: "hashed-story-residue",
    residueKind: "create",
    token: "c6013a4eac7b82afe53a4f5c22d727a2fae31356fbac9961680cc5eb9363a94e"
  });
  assert.deepEqual(classifyStoryEntry(entry(names.reap, true)), {
    kind: "hashed-story-residue",
    residueKind: "reap",
    token: "407bb8182cfcb4dc72fcabddbd50bac82a03d4f70b9d7b821fe72988feba9b77"
  });

  const longest = storyResidueNames("A".repeat(255));
  assert.ok(Buffer.byteLength(longest.create) <= 255);
  assert.ok(Buffer.byteLength(longest.reap) <= 255);
  for (const kind of ["create", "reap"] as const) {
    assert.ok(Buffer.byteLength(storyResidueIdentityName(kind, "A".repeat(255))) <= 255);
    assert.ok(Buffer.byteLength(storyResidueIdentityTempName(kind, "A".repeat(255))) <= 255);
  }
  assert.equal(storyResidueToken("create", "A".repeat(255)),
    "319e82326e98bdb381610a25153e8d10cd452c72d7b88122b4027e6483d27a57");

  assert.throws(() => storyResidueNames("bad_id"), StoryFormatError);
});

test("story residue: frozen direct-ID names remain recognizable without confusing hashes for IDs", () => {
  const names = legacyStoryResidueNames(DERIVED_ID);
  assert.deepEqual(classifyStoryEntry(entry(names.create, true)), {
    kind: "story-residue",
    residueKind: "create",
    storyId: DERIVED_ID
  });
  assert.deepEqual(classifyStoryEntry(entry(names.reap, true)), {
    kind: "story-residue",
    residueKind: "reap",
    storyId: DERIVED_ID
  });
  const collisionShapedLegacyId = `h1-${"a".repeat(64)}`;
  assert.deepEqual(classifyStoryEntry(entry(legacyStoryResidueNames(collisionShapedLegacyId).create, true)), {
    kind: "story-residue",
    residueKind: "create",
    storyId: collisionShapedLegacyId
  });
});

test("story residue: final identities are bounded strict JCS and bind kind, ID, token, and mutation", () => {
  for (const kind of ["create", "reap"] as const) {
    const storyId = kind === "create" ? CREATE_STORY_ID : DERIVED_ID;
    const token = storyResidueToken(kind, storyId);
    const record = residueIdentityRecord(kind, storyId);
    const text = formatStoryResidueIdentity(record);
    assert.ok(Buffer.byteLength(text) <= MAX_STORY_RESIDUE_IDENTITY_BYTES);
    assert.deepEqual(
      parseStoryResidueIdentityBytes(Buffer.from(text), { storyId, residueKind: kind }),
      record
    );
    assert.equal(storyResidueIdentityName(kind, storyId), `${storyResidueNames(storyId)[kind]}.identity`);
    assert.deepEqual(classifyStoryEntry(entry(storyResidueIdentityName(kind, storyId), false, true)), {
      kind: "story-residue-identity",
      residueKind: kind,
      token,
      phase: "final"
    });
    assert.deepEqual(classifyStoryEntry(entry(storyResidueIdentityTempName(kind, storyId), false, true)), {
      kind: "story-residue-identity",
      residueKind: kind,
      token,
      phase: "temporary"
    });
  }
  const longestId = "A".repeat(255);
  const longestRecord = residueIdentity("reap", longestId);
  assert.ok(Buffer.byteLength(longestRecord) <= MAX_STORY_RESIDUE_IDENTITY_BYTES);
  assert.equal(parseStoryResidueIdentityBytes(Buffer.from(longestRecord)).storyId, longestId);

  const text = residueIdentity("create", CREATE_STORY_ID);
  const token = storyResidueToken("create", CREATE_STORY_ID);
  for (const malformed of [
    `${text}\n`,
    text.replace(`"token":"${token}"`, `"token":"${"f".repeat(64)}"`),
    text.replace(CREATE_STORY_ID, "other-story"),
    text.replace(MUTATION_ID, "bad-mutation"),
    text.replace("{", '{"extra":true,'),
    text.replace('"schema":1', '"schema":2')
  ]) assert.throws(
    () => parseStoryResidueIdentityBytes(Buffer.from(malformed), { storyId: CREATE_STORY_ID, residueKind: "create" }),
    StoryFormatError
  );
  assert.throws(
    () => parseStoryResidueIdentityBytes(Buffer.from(text), { storyId: CREATE_STORY_ID, residueKind: "reap" }),
    /expected story and kind/
  );
  const mismatchedCreate = residueIdentityRecord("create", SECOND_CREATE_STORY_ID);
  assert.throws(() => formatStoryResidueIdentity(mismatchedCreate), /does not match its mutation ID/);
  assert.throws(
    () => parseStoryResidueIdentityBytes(Buffer.from(canonicalJson(mismatchedCreate))),
    /does not match its mutation ID/
  );
  assert.equal(
    parseStoryResidueIdentityBytes(Buffer.from(residueIdentity("reap", DERIVED_ID, SECOND_MUTATION_ID))).storyId,
    DERIVED_ID
  );
  assert.throws(
    () => parseStoryResidueIdentityBytes(Buffer.alloc(MAX_STORY_RESIDUE_IDENTITY_BYTES + 1)),
    /size limit/
  );
});

test("story residue: wrong node types and malformed reserved names fail closed", () => {
  for (const candidate of [
    entry("canonical", false),
    entry(".1667-story-create-canonical", false),
    entry(".1667-story-reap-canonical", false),
    entry(".1667-story-", true),
    entry(".1667-story-create-", true),
    entry(".1667-story-reap-bad_id", true),
    entry(`.1667-story-create-h1_${"a".repeat(63)}`, true),
    entry(`.1667-story-create-h1_${"A".repeat(64)}`, true),
    entry(`.1667-story-create-h1_${"a".repeat(64)}.identity`, true),
    entry(`.1667-story-create-h1_${"a".repeat(64)}.identity`, false),
    entry(`.1667-story-reap-h1_${"a".repeat(64)}.identity.tmp`, true),
    entry(`.1667-story-reap-h1_${"a".repeat(64)}.identity.tmp`, false),
    entry(`.1667-story-reap-h1_${"a".repeat(64)}.identity.tmp.extra`, false, true),
    entry(".1667-story-unknown-canonical", true)
  ]) {
    assert.throws(() => classifyStoryEntry(candidate), StoryFormatError, candidate.name);
  }
});

test("story residue: direct lookup validates final create and reap identities before refusing", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-create-residue-"));
  const store = new StoryStore(dataDir);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(dataDir, { recursive: true, force: true }); });

  const id = CREATE_STORY_ID;
  const names = storyResidueNames(id);
  const identityName = storyResidueIdentityName("create", id);
  const identity = residueIdentity("create", id);
  await writeFile(path.join(dataDir, identityName), identity);
  await mkdir(path.join(dataDir, names.create));

  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.load(id), /unfinished storage transition/);
  await assert.rejects(() => store.assertMutationSupported(id), /unfinished storage transition/);

  const identityOnlyId = SECOND_CREATE_STORY_ID;
  await writeFile(
    path.join(dataDir, storyResidueIdentityName("create", identityOnlyId)),
    residueIdentity("create", identityOnlyId, SECOND_MUTATION_ID)
  );
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.load(identityOnlyId), /unfinished storage transition/);

  const reapIdentityOnlyId = "reap-identity-only-story";
  await writeFile(
    path.join(dataDir, storyResidueIdentityName("reap", reapIdentityOnlyId)),
    residueIdentity("reap", reapIdentityOnlyId)
  );
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.load(reapIdentityOnlyId), /unfinished storage transition/);

  const reapId = "canonical-reap-story";
  await writeFile(path.join(dataDir, storyResidueIdentityName("reap", reapId)), residueIdentity("reap", reapId));
  await mkdir(path.join(dataDir, storyResidueNames(reapId).reap));
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.load(reapId), /unfinished storage transition/);
});

test("story residue: directories without final identity and malformed final identity fail closed", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-bad-create-residue-"));
  const store = new StoryStore(dataDir);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(dataDir, { recursive: true, force: true }); });

  const missingId = CREATE_STORY_ID;
  await mkdir(path.join(dataDir, storyResidueNames(missingId).create));
  await assert.rejects(() => store.load(missingId), /lacks its final identity/);
  await assert.rejects(() => store.list(), /lacks its final identity/);
  await writeFile(
    path.join(dataDir, storyResidueIdentityName("create", missingId)),
    residueIdentity("create", missingId)
  );

  const malformedId = "malformed-reservation";
  await writeFile(path.join(dataDir, storyResidueIdentityName("create", malformedId)), "{}");
  await assert.rejects(() => store.load(malformedId), StoryFormatError);
  await assert.rejects(() => store.list(), StoryFormatError);
});

test("story residue: reap directory without final identity fails closed", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-bad-reap-residue-"));
  const store = new StoryStore(dataDir);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(dataDir, { recursive: true, force: true }); });

  const id = "missing-reap-identity";
  await writeFile(path.join(dataDir, storyResidueIdentityTempName("reap", id)), "partial");
  await mkdir(path.join(dataDir, storyResidueNames(id).reap));
  await assert.rejects(() => store.load(id), /lacks its final identity/);
  await assert.rejects(() => store.list(), /lacks its final identity/);
});

test("story residue: scan rejects mismatched identity names but accepts sidecars beside canonical state", async (t) => {
  const mismatchedRoot = await mkdtemp(path.join(tmpdir(), "1667-mismatched-residue-"));
  const kindMismatchRoot = await mkdtemp(path.join(tmpdir(), "1667-kind-mismatched-residue-"));
  const conflictRoot = await mkdtemp(path.join(tmpdir(), "1667-conflicting-residue-"));
  const mismatchedStore = new StoryStore(mismatchedRoot);
  const kindMismatchStore = new StoryStore(kindMismatchRoot);
  const conflictStore = new StoryStore(conflictRoot);
  await Promise.all([mismatchedStore.init(), kindMismatchStore.init(), conflictStore.init()]);
  t.after(async () => {
    await Promise.all([
      mismatchedStore.waitForMaintenance(),
      kindMismatchStore.waitForMaintenance(),
      conflictStore.waitForMaintenance()
    ]);
    await Promise.all([
      rm(mismatchedRoot, { recursive: true, force: true }),
      rm(kindMismatchRoot, { recursive: true, force: true }),
      rm(conflictRoot, { recursive: true, force: true })
    ]);
  });

  const namedId = CREATE_STORY_ID;
  const payloadId = SECOND_CREATE_STORY_ID;
  await writeFile(
    path.join(mismatchedRoot, storyResidueIdentityName("create", namedId)),
    residueIdentity("create", payloadId, SECOND_MUTATION_ID)
  );
  await assert.rejects(() => mismatchedStore.list(), /name does not match its contents/);

  const kindMismatchId = "identity-kind-mismatch";
  await writeFile(
    path.join(kindMismatchRoot, storyResidueIdentityName("create", kindMismatchId)),
    residueIdentity("reap", kindMismatchId)
  );
  await assert.rejects(() => kindMismatchStore.list(), /name does not match its contents/);

  const createId = CREATE_STORY_ID;
  const reapId = "canonical-reap-sidecar";
  await conflictStore.create("Canonical create", createId);
  await conflictStore.create("Canonical reap", reapId);
  await writeFile(
    path.join(conflictRoot, storyResidueIdentityName("create", createId)),
    residueIdentity("create", createId)
  );
  await writeFile(
    path.join(conflictRoot, storyResidueIdentityName("reap", reapId)),
    residueIdentity("reap", reapId)
  );
  assert.deepEqual((await conflictStore.list()).map(({ id }) => id).sort(), [createId, reapId].sort());
  assert.equal((await conflictStore.load(createId)).id, createId);
  assert.equal((await conflictStore.load(reapId)).id, reapId);
  await assert.rejects(() => conflictStore.assertMutationSupported(createId), /unfinished storage transition/);
  await assert.rejects(() => conflictStore.assertMutationSupported(reapId), /unfinished storage transition/);
});

test("story residue: typed identity temps ignore partial bytes in scans and block direct access", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-residue-temp-"));
  const store = new StoryStore(dataDir);
  await store.init();
  t.after(async () => { await store.waitForMaintenance(); await rm(dataDir, { recursive: true, force: true }); });

  const createId = "partial-create-temp";
  const reapId = "partial-reap-temp";
  await writeFile(path.join(dataDir, storyResidueIdentityTempName("create", createId)), "{");
  await writeFile(path.join(dataDir, storyResidueIdentityTempName("reap", reapId)), Uint8Array.of(0xff, 0x00));
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.load(createId), /unfinished storage transition/);
  await assert.rejects(() => store.load(reapId), /unfinished storage transition/);

  const canonicalId = "canonical-with-temp";
  await store.create("Canonical with temp", canonicalId);
  await writeFile(path.join(dataDir, storyResidueIdentityTempName("create", canonicalId)), "partial");
  assert.deepEqual((await store.list()).map(({ id }) => id), [canonicalId]);
  assert.equal((await store.load(canonicalId)).id, canonicalId);
  await assert.rejects(() => store.assertMutationSupported(canonicalId), /unfinished storage transition/);
});

test("story residue: wrong typed-temp node and conflicting create/reap finals fail closed", async (t) => {
  const wrongTypeRoot = await mkdtemp(path.join(tmpdir(), "1667-residue-temp-type-"));
  const conflictRoot = await mkdtemp(path.join(tmpdir(), "1667-residue-kind-conflict-"));
  const wrongTypeStore = new StoryStore(wrongTypeRoot);
  const conflictStore = new StoryStore(conflictRoot);
  await Promise.all([wrongTypeStore.init(), conflictStore.init()]);
  t.after(async () => {
    await Promise.all([wrongTypeStore.waitForMaintenance(), conflictStore.waitForMaintenance()]);
    await Promise.all([
      rm(wrongTypeRoot, { recursive: true, force: true }),
      rm(conflictRoot, { recursive: true, force: true })
    ]);
  });

  const wrongTypeId = "wrong-temp-node";
  await mkdir(path.join(wrongTypeRoot, storyResidueIdentityTempName("reap", wrongTypeId)));
  await assert.rejects(() => wrongTypeStore.list(), /identity is not a regular file/);
  await assert.rejects(() => wrongTypeStore.load(wrongTypeId), /identity temp is not a regular file/);

  const conflictId = CREATE_STORY_ID;
  await writeFile(
    path.join(conflictRoot, storyResidueIdentityName("create", conflictId)),
    residueIdentity("create", conflictId)
  );
  await writeFile(
    path.join(conflictRoot, storyResidueIdentityName("reap", conflictId)),
    residueIdentity("reap", conflictId)
  );
  await assert.rejects(() => conflictStore.list(), /Conflicting story residue state/);
  await assert.rejects(() => conflictStore.load(conflictId), /Conflicting canonical\/residue state/);
});

test("story residue: optional sibling probes preserve long canonical StoryIds", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-long-story-id-"));
  const storiesDir = path.join(dataDir, "stories");
  const store = new StoryStore(storiesDir);
  await store.init();
  t.after(async () => {
    await store.waitForMaintenance();
    await rm(dataDir, { recursive: true, force: true });
  });
  const ids = [229, 230, 231, 232, 250, 251, 255].map((length) => "a".repeat(length));
  for (const id of ids) {
    const bundle = path.join(storiesDir, id);
    await mkdir(bundle);
    await writeFile(path.join(bundle, "manifest.json"), serializeManifest(emptyManifest(id)));
  }

  assert.deepEqual((await store.list()).map(({ id }) => id).sort(), [...ids].sort());
  for (const id of ids) {
    assert.equal((await store.load(id)).id, id);
    await store.assertMutationSupported(id);
  }
  await assert.rejects(() => store.load("z".repeat(255)), /Story not found/);

  const createdId = "b".repeat(255);
  assert.equal((await store.create("Created long ID", createdId)).id, createdId);
  await store.remove(createdId);
  await assert.rejects(() => store.load(createdId), /Story not found/);

  const legacyId = "c".repeat(220);
  await writeFile(path.join(storiesDir, `${legacyId}.json`), JSON.stringify({
    id: legacyId,
    title: "Legacy long ID",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    parts: []
  }));
  const migrated = await store.mutate(legacyId, (story) => { story.title = "Migrated long ID"; });
  assert.equal(migrated.title, "Migrated long ID");
  assert.equal((await store.load(legacyId)).title, "Migrated long ID");
  await store.remove(legacyId);
});

test("story lifecycle: startup reaps only exact ephemeral bundle names", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "1667-ephemeral-name-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exact = ".1667-staging-story-00000000-0000-4000-8000-000000000000.tmp";
  const unknown = `${exact}\n`;
  const boundedLong = stagingBundlePath(root, "x".repeat(255));
  assert.ok(Buffer.byteLength(path.basename(boundedLong)) <= 255);
  await Promise.all([mkdir(path.join(root, exact)), mkdir(path.join(root, unknown)), mkdir(boundedLong)]);

  await reapEphemeralBundles(root);

  assert.deepEqual(await readdir(root), [unknown]);
});

function emptyManifest(id: string): StoryManifestV5 {
  return {
    format: "1667-story",
    schemaVersion: 5,
    id,
    title: "Long ID",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    activeWordCount: 0,
    nodes: [],
    facts: [],
    activeRootId: null,
    bookmarks: [],
    recentNodeIds: [],
    chapterBreaks: []
  };
}

function residueIdentity(kind: "create" | "reap", storyId: string, mutationId = MUTATION_ID): string {
  return formatStoryResidueIdentity(residueIdentityRecord(kind, storyId, mutationId));
}

function residueIdentityRecord(kind: "create" | "reap", storyId: string, mutationId = MUTATION_ID) {
  return {
    schema: 1 as const,
    kind: kind === "create" ? "story-create-reservation" as const : "story-reap-reservation" as const,
    storyId,
    token: storyResidueToken(kind, storyId),
    mutationId
  };
}

function entry(name: string, directory: boolean, file = false): StoryDirectoryEntry {
  return { name, isDirectory: () => directory, isFile: () => file };
}
