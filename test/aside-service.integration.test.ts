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
  MAX_ASIDE_ANSWER_SCALARS,
  MAX_ASIDE_DOCUMENT_BYTES,
  MAX_ASIDE_TITLE_SCALARS,
  MAX_SIDE_NOTES,
  asideTitleFromQuestion,
  migrateAsideDocumentToUnanchored,
  serializeAsideSessionDocument,
  serializeAsideDocument,
  worstCaseAsideTurnUtf8Bytes
} from "../shared/aside.js";
import { hasUnpairedSurrogate } from "../shared/unicode.js";
import { isSealed } from "../shared/vault-cipher.js";
import {
  GenerationCancelledError,
  ServiceError
} from "../server/errors.js";
import { StoryService } from "../server/story-service.js";
import { exportNovelAiArchive } from "../server/novelai-export.js";
import { WorkerRequestCancellation } from "../server/worker-request-cancellation.js";
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
  const service = StoryService.withoutDiagnostics({
    dataDir,
    asideActivation: false
  });
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

  const predecessor = StoryService.withoutDiagnostics({
    dataDir,
    asideActivation: false
  });
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

  const predecessor = StoryService.withoutDiagnostics({
    dataDir,
    asideActivation: false
  });
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

test("v2 Aside creates, appends, and reloads a take-anchored session", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-aside-v2-service-"));
  const dataDir = path.join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await first.init();
  const created = await first.createStory("Aside v2 service");
  const withRoot = await first.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "The lantern burned."
  });
  const takeId = withRoot.path.at(-1)?.id;
  assert.ok(takeId !== undefined);
  const anchor = { partId: takeId, takeId };
  const firstMutation = await mintStoryMutationRequest(
    first.stories,
    created.id,
    "askAside",
    JSON.stringify({ question: "Why did it burn?", anchor })
  );

  const firstAnswer = await first.askAsideV2(
    created.id,
    { question: "Why did it burn?", anchor },
    async () => {},
    new AbortController().signal,
    { mutationRequest: firstMutation }
  );
  assert.ok(firstAnswer !== null);
  assert.equal(firstAnswer.anchor?.takeId, takeId);
  assert.equal(firstAnswer.turns.length, 1);
  assert.equal(firstAnswer.id.length > 0, true);

  const replayed = await first.askAsideV2(
    created.id,
    { question: "Why did it burn?", anchor },
    async () => {},
    new AbortController().signal,
    { mutationRequest: firstMutation }
  );
  assert.deepEqual(replayed, firstAnswer);

  const secondAnswer = await first.askAsideV2(
    created.id,
    { question: "What did it light?", anchor, sessionId: firstAnswer.id },
    async () => {},
    new AbortController().signal
  );
  assert.ok(secondAnswer !== null);
  assert.equal(secondAnswer.id, firstAnswer.id);
  assert.equal(secondAnswer.turns.length, 2);

  const scoped = await first.getAsideV2(created.id, anchor);
  assert.equal(scoped.sessions.length, 1);
  assert.equal(scoped.sessions[0]?.id, firstAnswer.id);
  assert.equal(scoped.sessions[0]?.turns.length, 2);
  assert.equal(scoped.anchors[0]?.sessionCount, 1);
  assert.equal(scoped.anchors[0]?.takeIndex, 1);
  assert.equal(scoped.anchors[0]?.takeCount, 1);
  await first.dispose();

  const second = StoryService.withoutDiagnostics({ dataDir, asideActivation: true });
  await second.init();
  const reloaded = await second.getAsideV2(created.id, anchor);
  assert.deepEqual(reloaded.sessions, scoped.sessions);
  assert.deepEqual(reloaded.anchors, scoped.anchors);
  await second.dispose();
});

test("v2 Aside keeps the predecessor V1 document visible as an unanchored session", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside v1 coexistence");

  const legacy = await service.askAside(
    created.id,
    { question: "Legacy question?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(legacy !== null);

  const before = await service.getAsideV2(created.id, null);
  assert.equal(before.sessions.length, 1);
  assert.equal(before.sessions[0]?.id, "legacy");
  assert.equal(before.sessions[0]?.turns.length, 1);
  assert.equal(before.unanchoredCount, 1);

  const appended = await service.askAsideV2(
    created.id,
    { question: "A successor question?", anchor: null, sessionId: "legacy" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(appended !== null);
  assert.equal(appended.id, "legacy");
  assert.equal(appended.anchor, null);
  assert.equal(appended.turns.length, 2);

  const oldRead = await service.getAside(created.id);
  assert.deepEqual(oldRead, legacy);
  const after = await service.getAsideV2(created.id, null);
  assert.equal(after.sessions.length, 1);
  assert.equal(after.sessions[0]?.turns.length, 2);
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

test("started Aside stop saves streamed text; stream failure saves nothing", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Aside cancellation");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "The lantern swung once."
  });

  const stopped = new AbortController();
  let stoppedText = "";
  const stoppedResult = await service.askAside(
    created.id,
    { question: "Stop after output." },
    async (delta) => {
      stoppedText += delta;
      stopped.abort(new GenerationCancelledError());
    },
    stopped.signal,
    { canCommitStoppedAside: () => true }
  );
  assert.ok(stoppedResult !== null, "Stop after output must save a Side Note");
  assert.ok(stoppedText.length > 0, "the provider must have streamed before Stop");
  assert.equal(stoppedResult.notes[0]!.answer, stoppedText.trim());
  assert.deepEqual(await service.getAside(created.id), stoppedResult);

  const superseded = new WorkerRequestCancellation(
    true,
    "00000000-0000-7000-8000-000000000001"
  );
  const supersededResult = await service.askAside(
    created.id,
    { question: "Do not save after shutdown supersedes Stop." },
    async () => {
      superseded.cancel("user");
      superseded.cancel("shutdown");
    },
    superseded.signal,
    { canCommitStoppedAside: () => superseded.userCancellationRequested }
  );
  assert.equal(supersededResult, null);
  assert.equal((await service.getAside(created.id)).notes.length, 1);

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
  assert.equal((await service.getAside(created.id)).notes.length, 1);
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

test("v2 Aside sessions report export omissions without exporting session text", async (t) => {
  const { service } = await openService(t);
  const created = await service.createStory("Export v2 Aside");
  const withRoot = await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "Prose stays."
  });
  const takeId = withRoot.path.at(-1)?.id;
  assert.ok(takeId !== undefined);
  const anchor = { partId: takeId, takeId };
  const saved = await service.askAsideV2(
    created.id,
    { question: "Secret v2 planning?", anchor, sessionId: "export-v2" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(saved !== null);

  const markdown = await service.exportStory(created.id);
  assert.deepEqual(markdown.fidelity, [ASIDE_EXPORT_OMISSION_NOTICE]);
  assert.equal(markdown.markdown.includes("Secret v2 planning?"), false);
  assert.equal(markdown.markdown.includes("Prose stays."), true);

  const payload = await service.loadStory(created.id);
  assert.equal(payload.hasAside, undefined);
  assert.equal(payload.hasAsideSessions, true);
  assert.equal(JSON.stringify(payload).includes("Secret v2 planning?"), false);
  const novelAi = exportNovelAiArchive(payload, "story");
  assert.ok(novelAi.fidelity.includes(ASIDE_EXPORT_OMISSION_NOTICE));
  assert.equal(novelAi.text.includes("Secret v2 planning?"), false);
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

test("near-limit V1 Aside stays lossless in the V2 read projection", async (t) => {
  const fixture = await setup(t, "1667-aside-v1-near-limit-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const firstQuestion = "😀".repeat(256);
  const noteCount = 8;
  const makeDocument = (answerLength: number) => ({
    schemaVersion: 1 as const,
    notes: Array.from({ length: noteCount }, (_, index) => ({
      question: index === 0 ? firstQuestion : `q${index}`,
      answer: "😀".repeat(answerLength)
    }))
  });
  let low = 0;
  let high = MAX_ASIDE_ANSWER_SCALARS;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const bytes = Buffer.byteLength(serializeAsideDocument(makeDocument(middle)), "utf8");
    if (bytes <= MAX_ASIDE_DOCUMENT_BYTES - 64) low = middle;
    else high = middle - 1;
  }
  const legacy = makeDocument(low);
  const legacyBytes = Buffer.byteLength(serializeAsideDocument(legacy), "utf8");
  assert.ok(legacyBytes > MAX_ASIDE_DOCUMENT_BYTES - 10_000);
  const displayTitle = [...firstQuestion].slice(0, MAX_ASIDE_TITLE_SCALARS).join("");
  assert.throws(
    () => migrateAsideDocumentToUnanchored(legacy, displayTitle),
    /would exceed its 1048576-byte size limit/u
  );

  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    commitAsideDocument(legacy)
  );
  const service = StoryService.withoutDiagnostics({
    dataDir: fixture.dataDir,
    asideActivation: true
  });
  await service.init();
  t.after(async () => { await service.dispose(); });

  const read = await service.getAsideV2(STORY_ID, null);
  assert.equal(read.sessions.length, 1);
  assert.equal(read.sessions[0]?.title, displayTitle);
  assert.equal(read.sessions[0]?.turns.length, noteCount);
  assert.deepEqual((await service.getAside(STORY_ID)).notes, legacy.notes);
});

test("near-limit migrated session reserves its first derived title before provider work", async (t) => {
  const fixture = await setup(t, "1667-aside-v1-title-admission-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const question = "x".repeat(MAX_ASIDE_TITLE_SCALARS);
  const titleDelta = Buffer.byteLength(JSON.stringify(asideTitleFromQuestion(question)), "utf8")
    - Buffer.byteLength(JSON.stringify(""), "utf8");
  const worstTurn = worstCaseAsideTurnUtf8Bytes(question);
  const targetBytes = MAX_ASIDE_DOCUMENT_BYTES - worstTurn - Math.ceil(titleDelta / 2);
  const fixedNotes = Array.from({ length: 25 }, (_, index) => ({
    question: `fixed-${index}`,
    answer: "a".repeat(MAX_ASIDE_ANSWER_SCALARS)
  }));
  const makeLegacy = (tailLength: number) => ({
    schemaVersion: 1 as const,
    notes: [
      ...fixedNotes,
      { question: "tail", answer: "a".repeat(tailLength) }
    ]
  });
  const migratedBytes = (tailLength: number): number => {
    const migrated = migrateAsideDocumentToUnanchored(makeLegacy(tailLength));
    assert.ok(migrated !== null);
    return Buffer.byteLength(serializeAsideSessionDocument(migrated), "utf8");
  };
  let low = 1;
  let high = MAX_ASIDE_ANSWER_SCALARS;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (migratedBytes(middle) <= targetBytes) low = middle;
    else high = middle - 1;
  }
  const legacy = makeLegacy(low);
  const migrated = migrateAsideDocumentToUnanchored(legacy);
  assert.ok(migrated !== null);
  const currentBytes = Buffer.byteLength(serializeAsideSessionDocument(migrated), "utf8");
  assert.ok(currentBytes + worstTurn <= MAX_ASIDE_DOCUMENT_BYTES);
  assert.ok(currentBytes + worstTurn + titleDelta > MAX_ASIDE_DOCUMENT_BYTES);
  assert.ok(Buffer.byteLength(serializeAsideDocument(legacy), "utf8") <= MAX_ASIDE_DOCUMENT_BYTES);

  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    commitAsideDocument(legacy)
  );
  const service = StoryService.withoutDiagnostics({
    dataDir: fixture.dataDir,
    asideActivation: true
  });
  await service.init();
  t.after(async () => { await service.dispose(); });

  let providerEntered = false;
  await assert.rejects(
    service.askAsideV2(
      STORY_ID,
      { question, anchor: null, sessionId: "legacy" },
      async () => { providerEntered = true; },
      new AbortController().signal,
      { providerStarted: async () => { providerEntered = true; } }
    ),
    hasCode("content_too_large")
  );
  assert.equal(providerEntered, false);
  assert.equal((await service.getAside(STORY_ID)).notes.length, 26);
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
