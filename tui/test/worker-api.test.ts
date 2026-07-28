import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_IMPORT_BYTES } from "../../shared/types.js";
import { unusedTakePruneSelection } from "../../shared/story-tree.js";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import { platformPerformanceBudget } from "../../test/performance-budget.js";
import {
  LEGACY_WORKER_PROTOCOL_VERSION,
  PROVIDER_CHECK_METHODS,
  WORKER_BUILD_IDENTITY,
  WORKER_PROVIDER_CHECK_TIMEOUT_MS,
  WORKER_PROTOCOL_VERSION,
  type MainToWorkerMessage,
  type WorkerToMainMessage
} from "../../shared/worker-protocol.js";
import { textHash, type StoryApi } from "../src/api.js";
import {
  BackendRestartRequiredError,
  createWorkerStoryApi,
  WorkerApiError
} from "../src/worker-api.js";
import { DataDirectoryLock } from "../../server/data-directory-lock.js";
import { MutationOutbox } from "../../server/mutation-outbox.js";
import { mutationFingerprint } from "../../server/mutation-receipts.js";
import { StoryService } from "../../server/story-service.js";
import { DEMO_SETTINGS_DOCUMENT, DEMO_SETTINGS_VIEW } from "../src/demo.js";
import {
  FakeWorker,
  TEST_WORKER_INSTANCE_ID,
  waitForRequest
} from "./fixtures/fake-worker.js";
import {
  nextWorkerMessage as nextMessage,
  nextWorkerMessageOfType as nextMessageOfType
} from "./fixtures/real-worker.js";

describe("embedded backend worker", () => {
  test("implements the complete StoryApi contract without HTTP", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-api-"));
    const previousData = process.env.AI_1667_DATA;
    process.env.AI_1667_DATA = dataDir;
    const backend = await createWorkerStoryApi();
    const api = backend.api;
    try {
      const defaults = await api.getSettings();
      expect(defaults.effective.provider).toBe("dry-run");
      if (!defaults.editable) throw new Error("fresh worker settings should use data format 2");
      await api.saveSettings({
        transportOperationId: crypto.randomUUID(),
        mutationId: createDurableMutationId(),
        expectedStateGeneration: defaults.stateGeneration,
        document: applyBasicSettingsDraft(defaults.document, {
          ...defaults.effective,
          maxTokens: 768
        })
      });
      const saved = await api.getSettings();
      expect(saved.effective.maxTokens).toBe(768);
      expect((await api.checkModelServer(saved.effective)).state).toBe("ready");
      expect((await api.probeContextWindow(saved.effective)).contextWindow).toBe(null);

      let story = await api.createStory("Worker contract");
      expect((await api.listStories()).map(({ id }) => id)).toContain(story.id);
      story = await api.renameStory(story.id, "Worker renamed");
      expect((await api.loadStory(story.id)).title).toBe("Worker renamed");

      story = await api.createNode(story.id, { parentId: null, instruction: "Open", text: "The red door opened." });
      const root = story.path[0]!;
      story = await api.editNode(story.id, root, { text: "The blue door opened." });
      expect(story.path[0]!.text).toContain("blue");
      const cut = await api.takeFromCut(story.id, root.id, { offset: 8, expected: "The blue" });
      expect(cut.path[0]!.text).toBe("The blue");
      story = await api.switchLine(story.id, root.id, { stopAtNode: true });

      story = await api.putBookmark(story.id, root.id, "Opening", "");
      expect(story.tags[0]?.name).toBe("Opening");
      expect(story.tags[0]?.status).toBe("");
      story = await api.deleteBookmark(story.id, root.id);
      expect(story.tags).toHaveLength(0);
      const prune = unusedTakePruneSelection(story);
      expect(prune.takeIds.length > 0).toBeTrue();
      story = await api.pruneUnusedTakes(story.id, {
        expectedStoryRevision: story.updatedAt,
        expectedTakeCount: prune.takeIds.length,
        expectedPartCount: prune.nodeIds.length
      });
      expect(story.nodes.some(({ id }) => prune.nodeIds.includes(id))).toBeFalse();

      story = await api.createFact(story.id, { tag: "Door", text: "The door is blue." });
      const factId = story.facts[0]!.id;
      story = await api.patchFact(story.id, factId, { text: "The door is midnight blue." });
      expect(story.facts[0]!.text).toContain("midnight");
      story = await api.deleteFact(story.id, factId);
      expect(story.facts).toHaveLength(0);

      const createdBreak = await api.createChapterBreak(story.id, root.id, "Chapter Two");
      story = await api.renameChapterBreak(story.id, createdBreak.breakId, "The Visitor");
      expect(story.chapterBreaks[0]?.title).toBe("The Visitor");
      story = await api.summarizeChapter(story.id, createdBreak.breakId);
      const chapterSummary = story.nodes.find((node) => node.chapterBreakId === createdBreak.breakId)!;
      expect(chapterSummary.role).toBe("summary");
      if (chapterSummary.text === undefined) throw new Error("Chapter summary text was not hydrated");
      story = await api.editChapterSummary(
        story.id, chapterSummary.id, "Edited chapter summary.", chapterSummary.text
      );
      expect(story.nodes.find((node) => node.id === chapterSummary.id)?.text).toBe("Edited chapter summary.");
      const removedBreak = await api.removeChapterBreak(story.id, createdBreak.breakId);
      expect(removedBreak.payload.chapterBreaks).toHaveLength(0);
      story = await api.restoreChapterBreak(story.id, createdBreak.breakId, removedBreak.removed);
      expect(story.chapterBreaks[0]?.id).toBe(createdBreak.breakId);

      story = await api.createNode(story.id, { parentId: root.id, text: "A temporary child." });
      const temporary = story.path.at(-1)!;
      story = await api.deleteNode(story.id, temporary.id, 1);
      expect(story.nodes.some(({ id }) => id === temporary.id)).toBeFalse();

      const deltas: string[] = [];
      const continued = await api.continueStory(
        story.id,
        "A visitor arrives.",
        "worker-continue",
        { parentId: root.id },
        (text) => deltas.push(text),
        new AbortController().signal
      );
      expect(continued?.path.at(-1)?.genId).toBe("worker-continue");
      expect(deltas.join("").length > 0).toBeTrue();
      story = continued!;

      const rewriteDeltas: string[] = [];
      await api.rewriteNode(
        story.id,
        root.id,
        { start: 4, end: 8, expected: "blue", instruction: "Change the color." },
        (text) => rewriteDeltas.push(text),
        new AbortController().signal
      );
      story = await api.loadStory(story.id);
      expect(story.path[0]!.text).toContain("placeholder");
      expect(rewriteDeltas.length > 0).toBeTrue();

      const summaryDeltas: string[] = [];
      const summaryId = await api.createSummaryTake(
        story.id,
        { nodeId: story.path.at(-1)!.id },
        (text) => summaryDeltas.push(text),
        new AbortController().signal
      );
      expect(summaryId === null).toBeFalse();
      expect(summaryDeltas.length > 0).toBeTrue();

      const cancel = new AbortController();
      let deltasAfterCancel = 0;
      const cancelled = await api.continueStory(
        story.id,
        "This must be cancelled.",
        "worker-cancel",
        { parentId: story.path.at(-1)!.id },
        () => {
          if (cancel.signal.aborted) deltasAfterCancel += 1;
          else cancel.abort();
        },
        cancel.signal
      );
      expect(cancelled).toBe(null);
      expect(deltasAfterCancel).toBe(0);
      expect((await api.loadStory(story.id)).path.some(({ genId }) => genId === "worker-cancel")).toBeFalse();

      const named = await api.autonameStory(story.id);
      expect(named.title).toBe("The Quiet After Rain");
      expect(await api.exportMarkdown(story.id)).toContain("# The Quiet After Rain");

      const imported = await api.importSillyTavern([
        JSON.stringify({ character_name: "Mira", user_name: "You" }),
        JSON.stringify({ is_user: true, mes: "Begin" }),
        JSON.stringify({ is_user: false, mes: "One" })
      ].join("\n"));
      expect(imported.path).toHaveLength(1);
      expect((await api.deleteStory(imported.id)).ok).toBeTrue();
      expect((await api.deleteStory(story.id)).ok).toBeTrue();

      expect(await rejection(api.loadStory("missing-story"))).toMatchObject({
        code: "not_found",
        status: 404
      } satisfies Partial<WorkerApiError>);
      expect(await rejection(api.importSillyTavern("x".repeat(MAX_IMPORT_BYTES + 1)))).toMatchObject({
        code: "content_too_large",
        status: 413
      } satisfies Partial<WorkerApiError>);
    } finally {
      await backend.dispose();
      if (previousData === undefined) delete process.env.AI_1667_DATA;
      else process.env.AI_1667_DATA = previousData;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("normalizes undefined optional fields to HTTP JSON semantics", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-undefined-"));
    const previousData = process.env.AI_1667_DATA;
    process.env.AI_1667_DATA = dataDir;
    const backend = await createWorkerStoryApi();
    try {
      let story = await backend.api.createStory("Undefined parity");
      story = await backend.api.createNode(story.id, { parentId: null, text: "Root." });
      let leaf = story.path[0]!;
      story = await backend.api.createNode(story.id, {
        parentId: undefined,
        appendTo: leaf.id,
        expectedTextHash: await textHash(leaf.text),
        genId: "undefined-create",
        text: " Extended."
      });
      expect(story.path[0]!.text).toBe("Root. Extended.");

      leaf = story.path[0]!;
      story = (await backend.api.continueStory(
        story.id,
        "",
        "undefined-continue",
        { parentId: undefined, appendTo: leaf.id, expectedTextHash: await textHash(leaf.text) },
        () => {},
        new AbortController().signal
      ))!;
      expect(story.path[0]!.text.length).toBeGreaterThan(leaf.text.length);

      story = await backend.api.createFact(story.id, { tag: "Place", text: "Old" });
      story = await backend.api.patchFact(story.id, story.facts[0]!.id, { tag: undefined, text: "New" });
      expect(story.facts[0]).toMatchObject({ tag: "Place", text: "New" });
    } finally {
      await backend.dispose();
      if (previousData === undefined) delete process.env.AI_1667_DATA;
      else process.env.AI_1667_DATA = previousData;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("retains the bootstrap lock until the embedded worker is disposed", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-bootstrap-lock-"));
    const backend = await createWorkerStoryApi({ dataDir });
    const contender = new DataDirectoryLock(dataDir);
    try {
      expect((await rejection(contender.acquire())).message).toContain("already open");
    } finally {
      await backend.dispose();
    }
    await contender.acquire();
    await contender.release();
    await rm(dataDir, { recursive: true, force: true });
  }, platformPerformanceBudget(10_000));

  test("preserves actionable storage failures during worker bootstrap", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-bootstrap-failure-"));
    const bootstrapLock = new DataDirectoryLock(dataDir);
    await bootstrapLock.acquire();
    await bootstrapLock.release();
    await writeFile(path.join(dataDir, "stories"), "not a directory\n");
    try {
      const error = await rejection(createWorkerStoryApi({ dataDir, startupTimeoutMs: 2_000 }));
      expect(error.message).toContain("Storage path is not a directory");
      expect(error.message).not.toContain("Malformed worker message");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fails background recovery instead of wedging when durable outbox cleanup fails", async () => {
    if (process.platform === "win32") return;
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-outbox-failure-"));
    const bootstrapLock = new DataDirectoryLock(dataDir);
    await bootstrapLock.acquire();
    await bootstrapLock.release();
    const outboxDir = path.join(dataDir, "mutation-outbox");
    const outbox = new MutationOutbox(outboxDir);
    await outbox.init();
    await outbox.enqueue(`m1-${Date.now().toString(36)}-${"9".padStart(32, "0")}`,
      "createStory", { title: "Cleanup failure" });
    await chmod(outboxDir, 0o500);
    let backend: Awaited<ReturnType<typeof createWorkerStoryApi>> | null = null;
    try {
      backend = await createWorkerStoryApi({ dataDir, startupTimeoutMs: 1_000 });
      const error = await Promise.race([
        rejection(backend.recovery),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("recovery wedged")), 2_000)
        )
      ]);
      expect(error.message).not.toBe("recovery wedged");
      expect((await backend.failure).message.length > 0).toBeTrue();
    } finally {
      await chmod(outboxDir, 0o700);
      await backend?.dispose().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("replays a durable caller outbox with the original mutation ID after restart", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-outbox-"));
    const mutationId = `m1-${Date.now().toString(36)}-${"7".padStart(32, "0")}`;
    const input = { title: "Recovered from outbox" };
    const service = StoryService.withoutDiagnostics({ dataDir });
    await service.init();
    await service.runMutation(mutationId, "createStory", input,
      (plan) => service.createStory(input.title, plan.entityId("story")),
      undefined,
      (plan) => service.stories.assertMutationSupported(plan.entityId("story")));
    await service.dispose();
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await outbox.enqueue(mutationId, "createStory", input);

    const backend = await createWorkerStoryApi({ dataDir });
    try {
      await backend.recovery;
      const stories = await backend.api.listStories();
      expect(stories).toHaveLength(1);
      expect(stories[0]!.title).toBe(input.title);
      expect(await outbox.list()).toEqual([]);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("executes an unsent durable caller outbox after restart", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-unsent-outbox-"));
    const mutationId = `m1-${Date.now().toString(36)}-${"8".padStart(32, "0")}`;
    const service = StoryService.withoutDiagnostics({ dataDir });
    await service.init();
    let story = await service.createStory("Sent after restart");
    story = await service.createNode(story.id, { parentId: null, text: "A summary source." });
    await service.dispose();
    const input = { storyId: story.id, body: { nodeId: story.nodes[0]!.id } };
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await outbox.enqueue(mutationId, "createSummaryTake", input);

    // Real worker startup competes with the full test pool; fake-worker tests
    // below retain the tight 100 ms liveness deadline.
    const backend = await createWorkerStoryApi({
      dataDir,
      readyTimeoutMs: 1_000,
      startupTimeoutMs: 5_000
    });
    try {
      const first = await Promise.race([
        backend.recovery.then(() => "recovery" as const),
        backend.api.listStories().then(() => "api" as const)
      ]);
      expect(first).toBe("api");
      await backend.recovery;
      expect((await backend.api.loadStory(story.id)).nodes.some((node) => node.role === "summary")).toBeTrue();
      expect(await outbox.list()).toEqual([]);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("holds new mutations behind startup outbox recovery", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-recovery-fence-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await outbox.enqueue(
      `m1-${Date.now().toString(36)}-${"5".padStart(32, "0")}`,
      "createStory",
      { title: "retained" }
    );
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    try {
      const foreground = backend.api.createStory("foreground");
      const requests = () => worker.messages.filter((message) => message.type === "request");
      expect(requests()).toHaveLength(1);

      const replay = requests()[0]!;
      worker.message({ type: "result", id: replay.id, value: { id: "retained", nodes: [], path: [] } });
      await backend.recovery;
      for (let attempt = 0; attempt < 20 && requests().length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(requests()).toHaveLength(2);

      const live = requests()[1]!;
      worker.message({ type: "result", id: live.id, value: { id: "foreground", nodes: [], path: [] } });
      expect((await foreground).id).toBe("foreground");
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("settings commands carry their own durable identity without an outer outbox receipt", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-settings-command-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    try {
      await backend.recovery;
      const command = {
        transportOperationId: crypto.randomUUID(),
        mutationId: createDurableMutationId(),
        expectedStateGeneration: 1,
        document: DEMO_SETTINGS_DOCUMENT
      };
      const saving = backend.api.saveSettings(command);
      const request = worker.messages.findLast((message) =>
        message.type === "request" && message.method === "saveSettings"
      );
      expect(request?.type).toBe("request");
      if (request?.type !== "request") throw new Error("settings request was not sent");
      expect(request.mutationId).toBe(undefined);
      expect(request.input).toEqual({ command });
      expect(await outbox.list()).toEqual([]);
      const result = {
        kind: "settings" as const,
        settingsStateGeneration: 1,
        activeSettingsRevision: 1,
        pendingSettingsRevision: null
      };
      worker.message({ type: "result", id: request.id, value: result });
      expect(await saving).toEqual(result);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("local mutations skip the durable outbox intent while provider mutations keep it", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-local-tier-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    try {
      await backend.recovery;
      const switching = backend.api.switchLine("story-1", "node-1");
      const load = await waitForRequest(worker, "loadStory");
      worker.message({ type: "result", id: load.id, value: {
        id: "story-1",
        nodes: [],
        path: [],
        aggregateVersion: { kind: "v6", revision: "00000000000000000001" }
      } });
      const local = await waitForRequest(worker, "switchLine");
      expect(typeof local.mutationId).toBe("string");
      expect(local.expectedAggregateVersion).toEqual({
        kind: "v6",
        revision: "00000000000000000001"
      });
      // The tier travels as an explicit wire marker, and the local tier
      // publishes no intent before or after send.
      expect(local.durability).toBe("manifest-only");
      expect(await outbox.list()).toEqual([]);
      worker.message({ type: "result", id: local.id, value: { id: "story-1", nodes: [], path: [] } });
      await switching;
      expect(await outbox.list()).toEqual([]);
      expect(await outbox.listCancellationMarkers()).toEqual([]);

      // A provider-backed mutation still writes its intent before the send
      // and durably removes it before the caller's promise resolves.
      const continuing = backend.api.continueStory(
        "story-1",
        "continue",
        "gen-1",
        {},
        () => {},
        new AbortController().signal
      );
      const generation = await waitForRequest(worker, "continueStory");
      expect(generation.durability).toBe(undefined);
      const inflight = await outbox.list();
      expect(inflight).toHaveLength(1);
      expect(inflight[0]!.mutationId).toBe(generation.mutationId!);
      expect(inflight[0]!.method).toBe("continueStory");
      worker.message({ type: "complete", id: generation.id, value: null });
      expect(await continuing).toBe(null);
      expect(await outbox.list()).toEqual([]);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps new mutations fenced after startup recovery rejects", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-recovery-reject-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await outbox.enqueue(
      `m1-${Date.now().toString(36)}-${"6".padStart(32, "0")}`,
      "createStory",
      { title: "retained" }
    );
    const worker = new RequestThrowingWorker();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    try {
      expect(await rejection(backend.recovery)).toMatchObject({
        code: "backend_restart_required"
      });
      expect((await backend.failure).message).toContain("request delivery failed");
      expect((await rejection(backend.api.listStories())).message).toContain("not running");
      expect(worker.requestAttempts).toBe(1);
      expect(await outbox.list()).toHaveLength(1);
      await expectRestartRequiredDisposal(backend);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("clears a durably cancelled startup intent without replaying it", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-cancelled-recovery-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    const mutationId = `m1-${Date.now().toString(36)}-${"b".padStart(32, "0")}`;
    await outbox.enqueue(mutationId, "continueStory", { storyId: "story", instruction: "cancelled" });
    await outbox.cancel(mutationId);
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    try {
      await backend.recovery;
      expect(worker.messages.some((message) => message.type === "request")).toBeFalse();
      expect(await outbox.list()).toEqual([]);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("surfaces replay errors without blocking startup", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-replay-warning-"));
    const service = StoryService.withoutDiagnostics({ dataDir });
    await service.init();
    let story = await service.createStory("Replay warning");
    story = await service.createNode(story.id, { parentId: null, text: "A detailed opening." });
    await service.dispose();

    const timestamp = Date.now().toString(36);
    const uncertainId = `m1-${timestamp}-${"3".padStart(32, "0")}`;
    const uncertainInput = { id: story.id, expectedTitle: story.title };
    await writeFile(path.join(dataDir, "mutation-receipts", `${uncertainId}.json`), `${JSON.stringify({
      format: "1667-mutation",
      schemaVersion: 1,
      mutationId: uncertainId,
      fingerprint: mutationFingerprint("autonameStory", uncertainInput),
      method: "autonameStory",
      state: "provider_started",
      createdAt: new Date().toISOString()
    })}\n`);
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await outbox.enqueue(uncertainId, "autonameStory", uncertainInput);
    const terminalId = `m1-${timestamp}-${"4".padStart(32, "0")}`;
    await outbox.enqueue(terminalId, "renameStory", { id: story.id });

    const backend = await createWorkerStoryApi({ dataDir });
    try {
      await backend.recovery;
      expect(backend.recoveryWarnings).toHaveLength(2);
      expect(backend.recoveryWarnings.map(({ error }) => error.code)).toEqual([
        "generation_outcome_unknown", "invalid_request"
      ]);
      expect(backend.recoveryWarnings.map(({ resolution }) => resolution)).toEqual(["archived", "cleared"]);
      expect((await backend.api.listStories()).map(({ id }) => id)).toContain(story.id);
      expect(await outbox.list()).toEqual([]);
      expect(JSON.parse(await readFile(
        path.join(dataDir, "mutation-outbox-archive", `${uncertainId}.json`),
        "utf8"
      ))).toMatchObject({
        format: "1667-mutation-outbox-archive",
        intent: { mutationId: uncertainId, method: "autonameStory" },
        resolution: { code: "generation_outcome_unknown" }
      });
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("archives a retained v3 mutation before current-schema parsing can clear it", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-v3-recovery-"));
    const service = StoryService.withoutDiagnostics({ dataDir });
    await service.init();
    const story = await service.createStory("Legacy autoname");
    await service.dispose();
    const mutationId = `m1-${Date.now().toString(36)}-${"c".padStart(32, "0")}`;
    const input = { id: story.id };
    await writeFile(path.join(dataDir, "mutation-receipts", `${mutationId}.json`), `${JSON.stringify({
      format: "1667-mutation",
      schemaVersion: 1,
      mutationId,
      fingerprint: mutationFingerprint("autonameStory", input, LEGACY_WORKER_PROTOCOL_VERSION),
      method: "autonameStory",
      state: "pending",
      createdAt: new Date().toISOString()
    })}\n`);
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await writeFile(path.join(dataDir, "mutation-outbox", `${mutationId}.json`), `${JSON.stringify({
      format: "1667-mutation-outbox",
      schemaVersion: 1,
      mutationId,
      method: "autonameStory",
      input,
      createdAt: new Date().toISOString()
    })}\n`);

    const backend = await createWorkerStoryApi({ dataDir });
    try {
      const warnings = await backend.recovery;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        mutationId,
        resolution: "archived",
        error: { code: "mutation_outcome_unknown" }
      });
      expect(await outbox.list()).toEqual([]);
      expect((await backend.api.loadStory(story.id)).title).toBe("Legacy autoname");
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("archives retained v3 flat settings without replaying them into format 2", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-v3-settings-"));
    const service = StoryService.withoutDiagnostics({ dataDir });
    await service.init();
    const before = await service.getSettings();
    await service.dispose();
    const mutationId = `m1-${Date.now().toString(36)}-${"d".padStart(32, "0")}`;
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    await writeFile(path.join(dataDir, "mutation-outbox", `${mutationId}.json`), `${JSON.stringify({
      format: "1667-mutation-outbox",
      schemaVersion: 1,
      mutationId,
      method: "saveSettings",
      input: { settings: { ...before.effective, maxTokens: before.effective.maxTokens + 1 } },
      createdAt: new Date().toISOString()
    })}\n`);

    const backend = await createWorkerStoryApi({ dataDir });
    try {
      const warnings = await backend.recovery;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        mutationId,
        method: "saveSettings",
        resolution: "archived",
        error: { code: "invalid_request" }
      });
      expect((await backend.api.getSettings()).effective.maxTokens).toBe(before.effective.maxTokens);
      expect(await outbox.list()).toEqual([]);
    } finally {
      await backend.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects every pending call when the worker crashes", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    const pending = backend.api.listStories();
    worker.crash("test worker crash");
    expect((await rejection(pending)).message).toMatch("test worker crash");
    expect((await backend.failure).message).toMatch("test worker crash");
    await expectRestartRequiredDisposal(backend);
    expect(worker.terminateCalls).toBe(1);
  });

  test("rejects malformed worker responses", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    const pending = backend.api.listStories();
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "result", id: "1" } }));

    expect((await rejection(pending)).message).toContain("malformed message");
    expect((await backend.failure).message).toContain("malformed message");
    await expectRestartRequiredDisposal(backend);
  });

  test("enforces an absolute startup deadline despite healthy heartbeats", async () => {
    const worker = new StartingWorker();
    const heartbeat = setInterval(() => worker.starting(), 1);
    try {
      const error = await rejection(createWorkerStoryApi({
        worker,
        readyTimeoutMs: 10,
        startupTimeoutMs: 25
      }));
      expect(error.message).toContain("did not become ready within 25 ms");
      expect(worker.terminateCalls).toBe(1);
    } finally {
      clearInterval(heartbeat);
    }
  });

  test("gives unary chapter generation the provider deadline", async () => {
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({
      worker,
      readyTimeoutMs: 100,
      mutationDeadlineMs: 5,
      streamDeadlineMs: 5_000
    });
    try {
      await primeStoryVersion(backend.api, worker);
      const pending = backend.api.summarizeChapter("story", "break");
      const request = await waitForRequest(worker, "summarizeChapter");
      expect(request.deadlineMs - Date.now()).toBeGreaterThan(4_000);
      worker.message({ type: "result", id: request.id, value: { id: "story" } });
      expect((await pending).id).toBe("story");
    } finally {
      await backend.dispose();
    }
  });

  test("gives provider checks their own deadline", async () => {
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({
      worker,
      readyTimeoutMs: 100,
      unaryTimeoutMs: 5
    });
    try {
      expect(PROVIDER_CHECK_METHODS.has("discoverModels")).toBeTrue();
      const pending = backend.api.probeContextWindow({
        provider: "dry-run",
        baseUrl: "",
        model: "",
        apiKeyEnv: null,
        temperature: 0,
        maxTokens: 128,
        systemPrompt: "Test.",
        contextWindow: null
      });
      const request = await waitForRequest(worker, "probeContextWindow");
      expect(request.deadlineMs - Date.now()).toBeGreaterThan(
        WORKER_PROVIDER_CHECK_TIMEOUT_MS - 1_000
      );
      worker.message({
        type: "result",
        id: request.id,
        value: { contextWindow: null }
      });
      expect(await pending).toEqual({ contextWindow: null });
    } finally {
      await backend.dispose();
    }
  });

  test("terminates when durable outbox publication is uncertain", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({ worker, outbox: new FailingEnqueueOutbox(), readyTimeoutMs: 100 });

    expect(await rejection(backend.api.createStory("uncertain publication"))).toMatchObject({
      code: "backend_restart_required"
    });
    expect((await backend.failure).message).toContain("intent publication failed");
    expect(worker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(backend);
  });

  test("hard-fences request delivery failure and retains the unsent intent", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-delivery-failure-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    const worker = new RequestThrowingWorker();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 1_000 });
    try {
      expect(await rejection(backend.api.createStory("retain after send failure"))).toMatchObject({
        code: "backend_restart_required"
      });
      expect((await backend.failure).message).toContain("request delivery failed");
      expect(worker.terminateCalls).toBe(1);
      expect(worker.requestAttempts).toBe(1);
      expect((await rejection(backend.api.listStories())).message).toContain("not running");
      expect(await outbox.list()).toHaveLength(1);
      await expectRestartRequiredDisposal(backend);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects oversized mutations before durable outbox publication", async () => {
    const worker = new FakeWorker(true);
    const outbox = new CountingOutbox();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });

    expect(await rejection(backend.api.createStory("x".repeat(1_000_001)))).toMatchObject({
      code: "content_too_large",
      status: 413
    });
    expect(outbox.enqueues).toBe(0);
    expect(worker.messages.some((message) => message.type === "request")).toBeFalse();
    await backend.dispose();
  });

  test("disposal drains outbox work before it can complete", async () => {
    const worker = new FakeWorker(true);
    const outbox = new DeferredEnqueueOutbox();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    const mutation = backend.api.createStory("drain before unlock");
    await outbox.started;
    let disposed = false;
    const disposal = backend.dispose().then(() => { disposed = true; });

    await Promise.resolve();
    expect(disposed).toBeFalse();
    outbox.finishEnqueue();
    expect((await rejection(mutation)).message).toContain("stopped before the mutation was sent");
    await disposal;
    expect(outbox.cancellations).toBe(1);
  });

  test("pre-delivery cancellation failure owns concurrent disposal", async () => {
    const worker = new FakeWorker(true);
    const outbox = new FailingPreDeliveryCancelOutbox();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    const mutationError = rejection(backend.api.createStory("cancel before unlock"));
    await outbox.started;
    const disposalError = rejection(backend.dispose());

    outbox.finishEnqueue();
    const failure = await backend.failure;
    expect(failure).toMatchObject({ code: "backend_restart_required" });
    expect(failure.message).toContain("cancellation could not be durably recorded before delivery");
    expect(await mutationError).toBe(failure);
    expect(await disposalError).toBe(failure);
  });

  test("terminates and retains recovery state for an uncertain mutation outcome", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    const pending = backend.api.createStory("uncertain");
    const request = await waitForRequest(worker, "createStory");
    worker.message({
      type: "error",
      id: request.id,
      failure: createFailureEnvelope({
        code: "mutation_outcome_unknown",
        message: "Mutation receipt durability could not be confirmed",
        status: 500
      }),
      mutationOutcome: "uncertain"
    });

    const pendingError = await rejection(pending);
    expect(pendingError.message).toContain("could not be confirmed");
    const backendFailure = await backend.failure;
    expect(backendFailure.message).toContain("could not be confirmed");
    expect(worker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(backend);
  });

  test("rejects unknown and malformed protocol messages without killing the worker", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-protocol-"));
    const previousData = process.env.AI_1667_DATA;
    process.env.AI_1667_DATA = dataDir;
    const dataLock = new DataDirectoryLock(dataDir);
    await dataLock.acquire();
    const worker = new Worker(new URL("../../server/worker.ts", import.meta.url), { type: "module" });
    try {
      worker.postMessage({ type: "bootstrap", dataDir, externalDataLock: true });
      const ready = await nextMessageOfType(worker, "ready");
      let operationSequence = 0n;
      const operationId = () => ({
        workerInstanceId: ready.workerInstanceId,
        sequence: ++operationSequence
      });
      const deadlineMs = Date.now() + 60_000;
      const unknownId = operationId();
      const unknown = nextMessage(worker);
      worker.postMessage({
        type: "request", id: unknownId, method: "missing", input: {}, protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs
      });
      expect(await unknown).toMatchObject({
        type: "error",
        id: unknownId,
        failure: { code: "invalid_request" }
      });

      const legacySettingsId = operationId();
      const legacySettings = nextMessage(worker);
      worker.postMessage({
        type: "request",
        id: legacySettingsId,
        method: "saveSettings",
        input: { settings: {} },
        protocolVersion: LEGACY_WORKER_PROTOCOL_VERSION,
        deadlineMs,
        mutationId: `m1-${Date.now().toString(36)}-${"0".padStart(32, "0")}`
      });
      expect(await legacySettings).toMatchObject({
        type: "error",
        id: legacySettingsId,
        failure: {
          code: "invalid_request",
          message: "This worker request must not include an outer mutation ID"
        }
      });

      const malformed = nextMessage(worker);
      worker.postMessage({ type: "nonsense" });
      expect(await malformed).toMatchObject({
        type: "protocolError",
        failure: {
          code: "invalid_request",
          message: "Unknown worker message type",
          status: 400
        }
      });

      const invalidDtoId = operationId();
      const invalidDto = nextMessage(worker);
      worker.postMessage({
        type: "request", id: invalidDtoId, method: "createNode", protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs,
        input: { storyId: "unused", body: { parentId: null, text: 42 } }
      });
      expect(await invalidDto).toMatchObject({
        type: "error",
        id: invalidDtoId,
        failure: { code: "invalid_request", status: 400 }
      });

      const mutationId = `m1-${Date.now().toString(36)}-${"1".padStart(32, "0")}`;
      const createOneId = operationId();
      const created = nextMessage(worker);
      worker.postMessage({
        type: "request", id: createOneId, method: "createStory", input: { title: "Once" },
        protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs, mutationId
      });
      const createdMessage = await created;
      expect(createdMessage).toMatchObject({ type: "result", id: createOneId });
      const createdId = (createdMessage as Extract<WorkerToMainMessage, { type: "result" }>).value as { id: string };

      const createTwoId = operationId();
      const replayed = nextMessage(worker);
      worker.postMessage({
        type: "request", id: createTwoId, method: "createStory", input: { title: "Once" },
        protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs, mutationId
      });
      expect(await replayed).toMatchObject({ type: "result", id: createTwoId, value: { id: createdId.id } });

      const createThreeId = operationId();
      const conflicted = nextMessage(worker);
      worker.postMessage({
        type: "request", id: createThreeId, method: "createStory", input: { title: "Twice" },
        protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs, mutationId
      });
      expect(await conflicted).toMatchObject({
        type: "error",
        id: createThreeId,
        failure: { code: "idempotency_conflict" }
      });

      const uncertainMutationId = `m1-${Date.now().toString(36)}-${"2".padStart(32, "0")}`;
      const uncertainInput = { id: createdId.id, expectedTitle: "Once" };
      await writeFile(path.join(dataDir, "mutation-receipts", `${uncertainMutationId}.json`), `${JSON.stringify({
        format: "1667-mutation",
        schemaVersion: 1,
        mutationId: uncertainMutationId,
        fingerprint: mutationFingerprint("autonameStory", uncertainInput),
        method: "autonameStory",
        state: "provider_started",
        createdAt: new Date().toISOString()
      })}\n`);
      const uncertainOperationId = operationId();
      const uncertain = nextMessage(worker);
      worker.postMessage({
        type: "request", id: uncertainOperationId, method: "autonameStory", input: uncertainInput,
        protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs, mutationId: uncertainMutationId
      });
      expect(await uncertain).toMatchObject({
        type: "error",
        id: uncertainOperationId,
        failure: { code: "generation_outcome_unknown" },
        mutationOutcome: "uncertain"
      });

      const corruptMutationId = `m1-${Date.now().toString(36)}-${"5".padStart(32, "0")}`;
      await writeFile(path.join(dataDir, "mutation-receipts", `${corruptMutationId}.json`), "not-json\n");
      const corruptOperationId = operationId();
      const corrupt = nextMessage(worker);
      worker.postMessage({
        type: "request", id: corruptOperationId, method: "createStory", input: { title: "Uncertain" },
        protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs, mutationId: corruptMutationId
      });
      const corruptMessage = await corrupt;
      expect(corruptMessage).toMatchObject({
        type: "error", id: corruptOperationId,
        failure: { code: "internal" },
        mutationOutcome: "uncertain"
      });
      const corruptFailure = (
        corruptMessage as Extract<WorkerToMainMessage, { type: "error" }>
      ).failure;
      expect(corruptFailure.kind).toBe("diagnostic");
      if (corruptFailure.kind !== "diagnostic") {
        throw new Error("expected diagnostic failure");
      }
      expect(corruptFailure.diagnosticRef).toMatch(/^err_[0-9a-f]{24}$/);

      const missingMutationId = operationId();
      const missingId = nextMessage(worker);
      worker.postMessage({
        type: "request", id: missingMutationId, method: "createStory", input: { title: "Missing" },
        protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs
      });
      expect(await missingId).toMatchObject({
        type: "error",
        id: missingMutationId,
        failure: { code: "invalid_request" }
      });

      const expiredId = `m1-${Date.now().toString(36)}-${"6".padStart(32, "0")}`;
      const expiredOperationId = operationId();
      const expired = nextMessage(worker);
      worker.postMessage({
        type: "request",
        id: expiredOperationId,
        method: "createStory",
        input: { title: "Must not replay" },
        protocolVersion: WORKER_PROTOCOL_VERSION,
        deadlineMs: Date.now() - 1,
        mutationId: expiredId
      });
      expect(await expired).toMatchObject({
        type: "error",
        id: expiredOperationId,
        mutationOutcome: "terminal",
        failure: { status: 408 }
      });

      const listOperationId = operationId();
      const stillAlive = nextMessage(worker);
      worker.postMessage({
        type: "request", id: listOperationId, method: "listStories", input: {}, protocolVersion: WORKER_PROTOCOL_VERSION, deadlineMs
      });
      const listed = await stillAlive;
      expect(listed).toMatchObject({ type: "result", id: listOperationId });
      expect((listed as Extract<WorkerToMainMessage, { type: "result" }>).value).toHaveLength(1);

      const stopped = nextMessage(worker);
      worker.postMessage({ type: "shutdown" });
      expect((await stopped).type).toBe("stopped");
    } finally {
      await worker.terminate();
      await dataLock.release();
      if (previousData === undefined) delete process.env.AI_1667_DATA;
      else process.env.AI_1667_DATA = previousData;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("waits for a graceful stop and then terminates the worker", async () => {
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    await backend.dispose();
    expect(worker.messages.at(-1)).toEqual({ type: "shutdown" });
    expect(worker.terminateCalls).toBe(1);
  });

  test("force-terminates a worker that never completes shutdown", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100, shutdownGraceMs: 5 });
    await expectRestartRequiredDisposal(backend);
    expect(worker.messages.at(-1)).toEqual({ type: "shutdown" });
    expect(worker.terminateCalls).toBe(1);
  });

  test("confirms worker exit when cancellation messaging throws", async () => {
    const worker = new CancelThrowingWorker();
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    const pending = backend.api.continueStory(
      "story", "Continue", "cancel-throws", { parentId: null },
      () => {}, new AbortController().signal
    );
    const pendingError = rejection(pending);

    await backend.dispose();

    expect((await pendingError).message).toBe("Embedded backend stopped");
    expect(worker.messages.at(-1)).toEqual({ type: "shutdown" });
    expect(worker.terminateCalls).toBe(1);
  });

  test("observes real worker exit before forced disposal returns", async () => {
    const worker = new Worker(new URL("fixtures/hung-worker.ts", import.meta.url), { type: "module" });
    let closed = false;
    worker.addEventListener("close", () => { closed = true; });
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 1_000, shutdownGraceMs: 5 });

    await expectRestartRequiredDisposal(backend);

    expect(closed).toBeTrue();
  });

  test("refuses to claim disposal when worker exit is unconfirmed", async () => {
    const worker = new NeverClosingWorker();
    const backend = await createWorkerStoryApi({
      worker,
      readyTimeoutMs: 100,
      shutdownGraceMs: 1,
      terminationConfirmMs: 5
    });

    expect(await rejection(backend.dispose())).toMatchObject({
      code: "backend_restart_required"
    });
    expect(worker.terminateCalls).toBe(1);
  });

  test("terminates and retains recovery when a stream delta consumer throws", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    await primeStoryVersion(backend.api, worker);
    const pending = backend.api.continueStory(
      "story", "Continue", "generation", { parentId: null },
      () => { throw new Error("render failed"); },
      new AbortController().signal
    );
    const request = await waitForRequest(worker, "continueStory");
    worker.message({ type: "delta", id: request.id, sequence: 0, text: "word" });

    expect((await rejection(pending)).message).toContain("render failed");
    expect((await backend.failure).message).toContain("render failed");
    expect(worker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(backend);
  });

  test("terminates on a stream sequence mismatch", async () => {
    const worker = new FakeWorker();
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    await primeStoryVersion(backend.api, worker);
    const pending = backend.api.continueStory(
      "story", "Continue", "generation", { parentId: null },
      () => {}, new AbortController().signal
    );
    const request = await waitForRequest(worker, "continueStory");
    worker.message({ type: "delta", id: request.id, sequence: 1, text: "out of order" });

    expect((await rejection(pending)).message).toContain("sequence mismatch");
    expect((await backend.failure).message).toContain("sequence mismatch");
    expect(worker.terminateCalls).toBe(1);
    await expectRestartRequiredDisposal(backend);
  });

  test("suppresses deltas queued after local cancellation", async () => {
    const worker = new FakeWorker(true);
    const backend = await createWorkerStoryApi({ worker, readyTimeoutMs: 100 });
    const cancel = new AbortController();
    const deltas: string[] = [];
    await primeStoryVersion(backend.api, worker);
    const pending = backend.api.continueStory(
      "story", "Continue", "generation", { parentId: null },
      (text) => deltas.push(text), cancel.signal
    );
    const request = await waitForRequest(worker, "continueStory");

    worker.message({ type: "delta", id: request.id, sequence: 0, text: "kept" });
    cancel.abort();
    worker.message({ type: "delta", id: request.id, sequence: 1, text: "late" });
    worker.message({ type: "complete", id: request.id, value: null });

    expect(await pending).toBe(null);
    expect(deltas).toEqual(["kept"]);
    await backend.dispose();
  });

  test("persists stream cancellation before notifying the worker", async () => {
    const worker = new FakeWorker(true);
    const outbox = new DeferredCancelOutbox();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    const cancel = new AbortController();
    try {
      await primeStoryVersion(backend.api, worker);
      const pending = backend.api.continueStory(
        "story", "Continue", "generation", { parentId: null }, () => {}, cancel.signal
      );
      const request = await waitForRequest(worker, "continueStory");
      cancel.abort();
      await outbox.cancelStarted;
      expect(worker.messages.some((message) => message.type === "cancel")).toBeFalse();
      outbox.finishCancel();
      for (let attempt = 0; attempt < 20 && !worker.messages.some((message) => message.type === "cancel"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(worker.messages.some((message) => message.type === "cancel")).toBeTrue();
      worker.message({ type: "complete", id: request.id, value: null });
      expect(await pending).toBe(null);
    } finally {
      outbox.finishCancel();
      await backend.dispose();
    }
  });

  test("persists pending mutation cancellation before shutdown reaches the worker", async () => {
    const worker = new FakeWorker(true);
    const outbox = new DeferredCancelOutbox();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    await primeStoryVersion(backend.api, worker);
    const pending = rejection(backend.api.continueStory(
      "story", "Continue", "generation", { parentId: null }, () => {}, new AbortController().signal
    ));
    await waitForRequest(worker, "continueStory");
    const disposal = backend.dispose();
    await outbox.cancelStarted;
    let secondDisposed = false;
    const concurrentDisposal = backend.dispose().then(() => { secondDisposed = true; });
    await Promise.resolve();
    expect(secondDisposed).toBeFalse();
    expect(worker.messages.some((message) => message.type === "cancel")).toBeFalse();
    expect(worker.messages.some((message) => message.type === "shutdown")).toBeFalse();

    outbox.finishCancel();
    await Promise.all([disposal, concurrentDisposal]);
    expect(worker.messages.some((message) => message.type === "cancel")).toBeTrue();
    expect(worker.messages.some((message) => message.type === "shutdown")).toBeTrue();
    expect((await pending).message).toContain("stopped");
  });

  test("stalled shutdown cancellation hard-fences disposal", async () => {
    const worker = new FakeWorker();
    const outbox = new DeferredCancelOutbox();
    const backend = await createWorkerStoryApi({
      worker,
      outbox,
      readyTimeoutMs: 100,
      cancelGraceMs: 5
    });
    await primeStoryVersion(backend.api, worker);
    const pendingError = rejection(backend.api.continueStory(
      "story", "Continue", "generation", { parentId: null }, () => {},
      new AbortController().signal
    ));
    await waitForRequest(worker, "continueStory");
    const disposalError = rejection(backend.dispose());
    await outbox.cancelStarted;

    const failure = await backend.failure;
    expect(failure).toMatchObject({ code: "backend_restart_required" });
    expect(failure.message).toContain("shutdown cancellation was not durably recorded");
    expect(await pendingError).toBe(failure);
    expect(await disposalError).toBe(failure);
    expect(worker.messages.some((message) => message.type === "shutdown")).toBeFalse();
    expect(worker.terminateCalls).toBe(1);
    outbox.finishCancel();
  });

  test("retains a startup replay when shutdown aborts its stream", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "1667-worker-replay-shutdown-"));
    const outbox = new MutationOutbox(path.join(dataDir, "mutation-outbox"));
    await outbox.init();
    const mutationId = `m1-${Date.now().toString(36)}-${"c".padStart(32, "0")}`;
    await outbox.enqueue(mutationId, "continueStory", { storyId: "story", instruction: "retained" });
    const worker = new CancelCompletingWorker();
    const backend = await createWorkerStoryApi({ worker, outbox, readyTimeoutMs: 100 });
    try {
      expect(worker.messages.some((message) => message.type === "request")).toBeTrue();
      await backend.dispose();
      expect(worker.messages.some((message) => message.type === "cancel")).toBeFalse();
      expect((await outbox.list()).map((record) => record.mutationId)).toEqual([mutationId]);
      expect((await rejection(backend.recovery)).message).toContain("stopped during mutation recovery");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

async function primeStoryVersion(
  api: Pick<StoryApi, "loadStory">,
  worker: FakeWorker,
  storyId = "story"
): Promise<void> {
  const loading = api.loadStory(storyId);
  const request = await waitForRequest(worker, "loadStory");
  worker.message({
    type: "result",
    id: request.id,
    value: {
      id: storyId,
      nodes: [],
      path: [],
      aggregateVersion: { kind: "v6", revision: "1" }
    }
  });
  await loading;
}

class StartingWorker extends EventTarget {
  terminateCalls = 0;

  postMessage(): void {}

  terminate(): void {
    this.terminateCalls += 1;
    this.dispatchEvent(new Event("close"));
  }

  starting(): void {
    this.dispatchEvent(new MessageEvent("message", { data: {
      type: "starting", protocolVersion: WORKER_PROTOCOL_VERSION,
      buildIdentity: WORKER_BUILD_IDENTITY,
      workerInstanceId: TEST_WORKER_INSTANCE_ID
    } }));
  }
}

class CancelThrowingWorker extends FakeWorker {
  constructor() { super(true); }

  override postMessage(message: MainToWorkerMessage): void {
    if (message.type === "cancel") throw new Error("cancel channel closed");
    super.postMessage(message);
  }
}

class RequestThrowingWorker extends FakeWorker {
  requestAttempts = 0;

  constructor() { super(true); }

  override postMessage(message: MainToWorkerMessage): void {
    if (message.type === "request") {
      this.requestAttempts += 1;
      throw new Error("request channel closed");
    }
    super.postMessage(message);
  }
}

class CancelCompletingWorker extends FakeWorker {
  constructor() { super(true); }

  override postMessage(message: MainToWorkerMessage): void {
    if (message.type === "cancel") {
      this.message({ type: "complete", id: message.id, value: null });
    }
    super.postMessage(message);
  }
}

class NeverClosingWorker extends EventTarget {
  terminateCalls = 0;

  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: {
      type: "ready", protocolVersion: WORKER_PROTOCOL_VERSION,
      buildIdentity: WORKER_BUILD_IDENTITY,
      workerInstanceId: TEST_WORKER_INSTANCE_ID
    } })));
  }

  postMessage(): void {}

  terminate(): void {
    this.terminateCalls += 1;
  }
}

class DeferredCancelOutbox extends MutationOutbox {
  private markCancelStarted!: () => void;
  private finish!: () => void;
  readonly cancelStarted = new Promise<void>((resolve) => { this.markCancelStarted = resolve; });
  private readonly cancellation = new Promise<void>((resolve) => { this.finish = resolve; });
  constructor() { super("unused-cancel-outbox"); }
  override async init(): Promise<void> {}
  override async enqueue(): Promise<void> {}
  override async cancel(): Promise<void> {
    this.markCancelStarted();
    await this.cancellation;
  }
  override async remove(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
  override async listArchived(): Promise<[]> { return []; }
  finishCancel(): void { this.finish(); }
}

class FailingEnqueueOutbox extends MutationOutbox {
  constructor() { super("unused-failing-outbox"); }
  override async init(): Promise<void> {}
  override async enqueue(): Promise<void> { throw new Error("outbox sync failed after publication"); }
  override async remove(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
}

class CountingOutbox extends MutationOutbox {
  enqueues = 0;
  constructor() { super("unused-counting-outbox"); }
  override async init(): Promise<void> {}
  override async enqueue(): Promise<void> { this.enqueues += 1; }
  override async remove(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
}

class DeferredEnqueueOutbox extends MutationOutbox {
  cancellations = 0;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  private finish!: () => void;
  private readonly enqueueFinished = new Promise<void>((resolve) => { this.finish = resolve; });

  constructor() { super("unused-deferred-outbox"); }
  override async init(): Promise<void> {}
  override async enqueue(): Promise<void> {
    this.markStarted();
    await this.enqueueFinished;
  }
  override async cancel(): Promise<void> { this.cancellations += 1; }
  override async remove(): Promise<void> {}
  override async list(): Promise<[]> { return []; }
  finishEnqueue(): void { this.finish(); }
}

class FailingPreDeliveryCancelOutbox extends DeferredEnqueueOutbox {
  override async cancel(): Promise<void> {
    throw new Error("pre-delivery cancellation failed");
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error("Expected promise to reject");
}

async function expectRestartRequiredDisposal(
  backend: { dispose(): Promise<void> }
): Promise<void> {
  const error = await rejection(backend.dispose());
  expect(error instanceof BackendRestartRequiredError).toBeTrue();
  expect(error).toMatchObject({ code: "backend_restart_required" });
}
