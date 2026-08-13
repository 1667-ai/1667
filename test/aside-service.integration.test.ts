/**
 * StoryService-level Aside behavior: persistence, capacity, export, delete, vault.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ASIDE_EXPORT_OMISSION_NOTICE,
  MAX_SIDE_NOTES
} from "../shared/aside.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { isSealed } from "../shared/vault-cipher.js";
import { ServiceError } from "../server/errors.js";
import { StoryService } from "../server/story-service.js";
import {
  STORY_REAP_RETENTION_MS,
  StoryReaper
} from "../server/story-reaper.js";
import { createMutationCoordinator } from "../server/mutation-coordinator.js";
import { encryptVault, decryptVault } from "../server/vault-lifecycle.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { mintStoryMutationRequest } from "../server/story-mutation-request.js";
import {
  FINGERPRINT,
  MUTATION_ID,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";
import {
  commitAsideDocument,
  ensureRootPart,
  hasCode,
  openService
} from "./aside-test-helpers.js";

test("the predecessor service keeps every Aside entry point closed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-closed-"));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const created = await service.createStory("Closed Aside");
  const signal = new AbortController().signal;

  await assert.rejects(() => service.getAside(created.id), hasCode("aside_not_supported"));
  await assert.rejects(
    () => service.askAside(created.id, { question: "Closed?" }, async () => {}, signal),
    hasCode("aside_not_supported")
  );
  await assert.rejects(
    () => service.clearAside(created.id),
    hasCode("aside_not_supported")
  );
});

test("the inactive predecessor replays supplied Aside identities, but not new requests", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-predecessor-service-"));
  const dataDir = path.join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));
  const writer = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await writer.init();
  const created = await writer.createStory("Predecessor recovery");
  const askRequest = await mintStoryMutationRequest(
    writer.stories,
    created.id,
    "askAside",
    "Why?"
  );
  const saved = await writer.askAside(
    created.id,
    { question: "Why?" },
    async () => {},
    new AbortController().signal,
    { mutationRequest: askRequest }
  );
  assert.ok(saved !== null);
  await writer.dispose();

  const predecessor = StoryService.withoutDiagnostics({ dataDir });
  await predecessor.init();
  const replayed = await predecessor.askAside(
    created.id,
    { question: "Why?" },
    async () => {},
    new AbortController().signal,
    { mutationRequest: askRequest }
  );
  assert.deepEqual(replayed, saved);
  await assert.rejects(
    () => predecessor.askAside(
      created.id,
      { question: "New?" },
      async () => {},
      new AbortController().signal
    ),
    hasCode("aside_not_supported")
  );
  await predecessor.dispose();
});

test("askAside persists across restart; stop saves nothing; clear stays empty", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-persist-"));
  const dataDir = path.join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await first.init();
  const created = await first.createStory("Persist Aside");
  await first.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "The lantern swung once."
  });
  const saved = await first.askAside(
    created.id,
    { question: "Why did the lantern swing?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(saved !== null && saved.notes.length === 1);
  await first.dispose();

  const second = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await second.init();
  const reloaded = await second.getAside(created.id);
  assert.equal(reloaded.notes.length, 1);
  assert.equal(reloaded.notes[0]!.question, "Why did the lantern swing?");
  assert.equal(reloaded.notes[0]!.answer, saved!.notes[0]!.answer);

  const abort = new AbortController();
  abort.abort();
  const cancelled = await second.askAside(
    created.id,
    { question: "Should not save" },
    async () => {},
    abort.signal
  );
  assert.equal(cancelled, null);
  assert.equal((await second.getAside(created.id)).notes.length, 1);

  await second.clearAside(created.id);
  assert.equal((await second.getAside(created.id)).notes.length, 0);
  await second.dispose();

  const third = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await third.init();
  assert.equal((await third.getAside(created.id)).notes.length, 0);
  await third.dispose();
});

test("activated direct local and provider mutations keep V10 writable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-direct-v10-"));
  const dataDir = path.join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));

  const writer = StoryService.withoutDiagnostics({
    dataDir,
    asideActivation: true
  });
  await writer.init();
  const created = await writer.createStory("Direct V10");
  await writer.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A direct mutation can follow an Aside answer."
  });
  await writer.askAside(
    created.id,
    { question: "Why?" },
    async () => {},
    new AbortController().signal
  );

  const renamed = await writer.renameStory(created.id, "Renamed after Aside");
  assert.equal(renamed.title, "Renamed after Aside");
  const withFact = await writer.createFact(created.id, { text: "A durable fact." });
  assert.equal(withFact.facts.at(-1)?.text, "A durable fact.");
  const rootNodeId = withFact.path[0]!.id;
  const createdChapter = await writer.createChapterBreak(
    created.id,
    rootNodeId,
    "After Aside"
  );
  assert.equal(createdChapter.payload.chapterBreaks[0]?.id, createdChapter.breakId);
  const removedChapter = await writer.deleteChapterBreak(
    created.id,
    createdChapter.breakId
  );
  assert.equal(removedChapter.removed.break.id, createdChapter.breakId);
  assert.equal(removedChapter.payload.chapterBreaks.length, 0);
  const autonamed = await writer.autonameStory(
    created.id,
    new AbortController().signal
  );
  assert.equal(autonamed.title, "The Quiet After Rain");
  await writer.dispose();

  const predecessor = StoryService.withoutDiagnostics({ dataDir });
  await predecessor.init();
  await assert.rejects(
    () => predecessor.renameStory(created.id, "Must stay closed"),
    hasCode("story_manifest_requires_successor")
  );
  await assert.rejects(
    () => predecessor.autonameStory(created.id, new AbortController().signal),
    hasCode("story_manifest_requires_successor")
  );
  await predecessor.dispose();
});

test("askAside returns its committed view without a post-commit document reload; replay reads it", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside replay view");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "A lantern burned."
  });
  const mutationRequest = await mintStoryMutationRequest(
    service.stories,
    created.id,
    "askAside",
    "Why did it burn?"
  );
  let failReads = true;
  const originalLoadAsideDocument = service.stories.loadAsideDocument;
  service.stories.loadAsideDocument = async (id: string) => {
    if (failReads) throw new Error("post-commit Aside reload must not run");
    return await originalLoadAsideDocument.call(service.stories, id);
  };

  const first = await service.askAside(
    created.id,
    { question: "Why did it burn?" },
    async () => {},
    new AbortController().signal,
    { mutationRequest }
  );
  assert.ok(first !== null && first.notes.length === 1);

  failReads = false;
  const replayed = await service.askAside(
    created.id,
    { question: "Why did it burn?" },
    async () => {},
    new AbortController().signal,
    { mutationRequest }
  );
  assert.deepEqual(replayed, first);
});

test("dry-run Aside keeps a scalar-safe question prefix at an emoji boundary", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside Unicode boundary");
  const question = "a".repeat(199) + "😀 why?";
  const deltas: string[] = [];

  const saved = await service.askAside(
    created.id,
    { question },
    async (delta) => { deltas.push(delta); },
    new AbortController().signal
  );

  assert.ok(saved !== null, "the valid Unicode question must produce a Side Note");
  const answer = saved.notes[0]!.answer;
  assert.equal(hasUnpairedSurrogate(answer), false);
  assert.equal(hasUnpairedSurrogate(deltas.join("")), false);
  assert.match(answer, /😀/u, "the complete boundary scalar stays in the dry-run answer");
});

test("started Aside stop and stream failure save no partial Side Note", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside cancellation");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "The lantern swung once."
  });

  const stopped = new AbortController();
  let stoppedDeltas = 0;
  const stoppedResult = await service.askAside(
    created.id,
    { question: "Stop after output." },
    async (delta) => {
      stoppedDeltas += delta.length;
      stopped.abort();
    },
    stopped.signal
  );
  assert.equal(stoppedResult, null);
  assert.ok(stoppedDeltas > 0, "the provider must have streamed before Stop");
  assert.equal((await service.getAside(created.id)).notes.length, 0);

  let failedDeltas = 0;
  await assert.rejects(
    service.askAside(
      created.id,
      { question: "Fail after output." },
      async (delta) => {
        failedDeltas += delta.length;
        throw new Error("consumer failed after Aside output");
      },
      new AbortController().signal
    ),
    /consumer failed after Aside output/u
  );
  assert.ok(failedDeltas > 0, "the provider must have streamed before failure");
  assert.equal((await service.getAside(created.id)).notes.length, 0);
});

test("export omits Side Notes with the exact notice; payload has presence only", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Export Aside");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "Prose stays."
  });
  await service.askAside(
    created.id,
    { question: "Secret planning?" },
    async () => {},
    new AbortController().signal
  );
  const exported = await service.exportStory(created.id);
  assert.equal(exported.markdown.includes("Secret planning?"), false);
  assert.equal(exported.markdown.includes("Prose stays."), true);
  assert.deepEqual(exported.fidelity, [ASIDE_EXPORT_OMISSION_NOTICE]);

  const payload = await service.loadStory(created.id);
  assert.equal(payload.hasAside, true);
  assert.equal(JSON.stringify(payload).includes("Secret planning?"), false);
});

test("delete makes Side Notes unreadable; reap removes the physical bundle", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-reap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "project");
  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  const created = await service.createStory("Reap Aside");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "Line."
  });
  await service.askAside(
    created.id,
    { question: "Gone soon?" },
    async () => {},
    new AbortController().signal
  );
  const storyId = created.id;
  const bundle = path.join(dataDir, "stories", storyId);
  assert.equal((await service.getAside(storyId)).notes.length, 1);
  await service.deleteStory(storyId);
  await assert.rejects(
    () => service.getAside(storyId),
    (error: unknown) => error instanceof ServiceError
  );
  await service.dispose();

  const far = new StoryReaper(
    dataDir,
    createMutationCoordinator(),
    { now: () => new Date(Date.now() + STORY_REAP_RETENTION_MS + 86_400_000) }
  );
  await far.reapIfEligible(storyId);
  await assert.rejects(
    () => access(bundle),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
});

test("service refuse capacity before provider work when notes are full", async (t) => {
  const fixture = await setup(t, "1667-aside-full-svc-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const notes = Array.from({ length: MAX_SIDE_NOTES }, (_, i) => ({
    question: `q${i}`,
    answer: `a${i}`
  }));
  const document = { schemaVersion: 1 as const, notes };
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    commitAsideDocument(document)
  );
  let providerEntered = false;
  const service = StoryService.withoutDiagnostics({
    dataDir: fixture.dataDir,
    asideActivation: true
  });
  await service.init();
  t.after(async () => { await service.dispose(); });
  await assert.rejects(
    service.askAside(
      STORY_ID,
      { question: "one more?" },
      async () => { providerEntered = true; },
      new AbortController().signal
    ),
    (error: unknown) => error instanceof ServiceError && error.code === "content_too_large"
  );
  assert.equal(providerEntered, false);
  assert.equal((await service.getAside(STORY_ID)).notes.length, MAX_SIDE_NOTES);
});

test("encrypted vault seals Side Notes; unseal restores them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-vault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "project");
  const lock = new DataDirectoryLock(dataDir);
  await lock.acquire();
  await lock.release();

  const service = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await service.init();
  const created = await service.createStory("Vault Aside");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "Prose."
  });
  const canary = "vault-aside-canary-unique-phrase";
  await service.askAside(
    created.id,
    { question: canary },
    async () => {},
    new AbortController().signal
  );
  const asideDir = path.join(dataDir, "stories", created.id, "aside");
  const entries = await readdir(asideDir, { recursive: true });
  const asideRel = entries.find((entry) => entry.endsWith(".json"));
  assert.ok(asideRel, "aside object file");
  const asideFile = path.join(asideDir, asideRel!);
  const plain = await readFile(asideFile, "utf8");
  assert.ok(plain.includes(canary));
  await service.dispose();

  await encryptVault({ dataDirectory: dataDir, password: "correct horse battery staple" });
  const sealed = await readFile(asideFile);
  assert.equal(isSealed(sealed), true);
  assert.equal(sealed.toString("utf8").includes(canary), false);

  await decryptVault({ dataDirectory: dataDir, password: "correct horse battery staple" });
  const restored = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await restored.init();
  assert.equal((await restored.getAside(created.id)).notes[0]!.question, canary);
  await restored.dispose();
});
