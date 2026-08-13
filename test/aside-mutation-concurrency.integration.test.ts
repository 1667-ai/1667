/**
 * Durable mutation-layer Aside behavior: cleanup, busy, idempotency, crash, predecessor.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import { applyBasicSettingsDraft } from "../shared/settings-basic-draft.js";
import { ServiceError } from "../server/errors.js";
import {
  FINGERPRINT,
  MUTATION_ID,
  OTHER_FINGERPRINT,
  OTHER_MUTATION_ID,
  THIRD_MUTATION_ID,
  providerOperation,
  requestFor,
  setup,
  STORY_ID
} from "./story-mutation-fixtures.js";
import {
  commitAsideDocument,
  ensureRootPart,
  hasCode,
  openService,
  seedAsideNote
} from "./aside-test-helpers.js";

test("Aside leaf is reaped after clear", async (t) => {
  const fixture = await setup(t, "1667-aside-clean-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Q?", answer: "A." }]
  };
  const committed = await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    commitAsideDocument(document)
  );
  const story = await fixture.stories.load(STORY_ID);
  assert.equal(typeof story.asideDocumentId, "string");
  const objectId = story.asideDocumentId!;
  const objectFile = path.join(
    fixture.dataDir,
    "stories",
    STORY_ID,
    "aside",
    objectId.slice(0, 2),
    `${objectId}.json`
  );
  await readFile(objectFile);

  await fixture.mutations.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, committed.aggregateVersion),
    "clearAside",
    (s) => {
      s.asideDocumentId = null;
    }
  );
  await fixture.stories.waitForMaintenance();
  await assert.rejects(
    () => readFile(objectFile),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );
});

test("clearAside returns resource_busy while a provider request is unresolved", async (t) => {
  const fixture = await setup(t, "1667-aside-busy-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => { started = resolve; });

  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Q?", answer: "A." }]
  };
  const provider = fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    providerOperation(
      async (stories, start) => {
        await start();
        started();
        await gate;
        await stories.commitProviderEffect(STORY_ID, {
          kind: "aside",
          expectedAsideDocumentId: undefined,
          document
        });
        return document;
      },
      () => document
    )
  );
  await startedP;

  await assert.rejects(
    fixture.mutations.runLocal(
      requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, version),
      "clearAside",
      (story, session) => {
        if (session.snapshot.manifest.unresolvedProvider !== null) {
          throw new ServiceError(
            409,
            "A model request for this story is still unresolved.",
            "resource_busy"
          );
        }
        story.asideDocumentId = null;
      }
    ),
    hasCode("resource_busy")
  );

  release();
  await provider;
});

test("Ask revalidates its Aside identity after Clear before provider dispatch", async (t) => {
  const { service } = await openService(t);
  let providerRequests = 0;
  const providerBodies: string[] = [];
  const provider = createServer((request, response) => {
    providerRequests += 1;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      providerBodies.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        "data: {\"choices\":[{\"delta\":{\"content\":\"unexpected\"},\"finish_reason\":\"stop\"}]}\n\n"
          + "data: [DONE]\n\n"
      );
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = (provider.address() as AddressInfo).port;
  t.after(async () => await new Promise<void>((resolve, reject) =>
    provider.close((error) => error === undefined ? resolve() : reject(error))
  ));
  const currentSettings = await service.getSettings();
  assert.ok(currentSettings.document);
  await service.saveSettings({
    transportOperationId: crypto.randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: currentSettings.stateGeneration,
    document: applyBasicSettingsDraft(currentSettings.document, {
      ...currentSettings.effective,
      provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "aside-race-fixture",
      apiKeyEnv: null,
      allowInsecureHttp: true
    })
  });
  const created = await service.createStory("Aside start guard");
  await service.createNode(created.id, {
    parentId: null,
    instruction: "",
    text: "The old Side Note must not reach the provider."
  });
  const seeded = await service.askAside(
    created.id,
    { question: "What was old?" },
    async () => {},
    new AbortController().signal
  );
  assert.ok(seeded !== null);
  providerRequests = 0;
  providerBodies.length = 0;

  let releaseBind!: () => void;
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  let bound!: () => void;
  const boundP = new Promise<void>((resolve) => { bound = resolve; });
  let providerStarted = false;
  const deltas: string[] = [];
  const ask = service.askAside(
    created.id,
    { question: "What changed?" },
    async (delta) => { deltas.push(delta); },
    new AbortController().signal,
    {
      bindIntent: async () => {
        bound();
        await bindGate;
      },
      providerStarted: () => { providerStarted = true; }
    }
  );
  await boundP;

  await service.clearAside(created.id);
  releaseBind();

  await assert.rejects(ask, hasCode("conflict"));
  assert.equal(providerStarted, false, "Clear must win before provider dispatch");
  assert.equal(providerRequests, 0, "the provider must not receive the cleared Aside history");
  assert.equal(providerBodies.join(""), "");
  assert.equal(deltas.join(""), "");
  assert.equal((await service.getAside(created.id)).notes.length, 0);
});

test("an admitted Aside answer cannot resurrect Side Notes cleared before provider start", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-stale-clear-",
    {},
    undefined,
    { asideActivation: true }
  );
  const admittedVersion = await seedAsideNote(fixture);
  const admittedStory = await fixture.stories.load(STORY_ID);
  const expectedAsideDocumentId = admittedStory.asideDocumentId!;
  let admitted!: () => void;
  const admittedP = new Promise<void>((resolve) => { admitted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const staleDocument = {
    schemaVersion: 1 as const,
    notes: [
      { question: "Keep?", answer: "Yes." },
      { question: "Stale?", answer: "Must not return." }
    ]
  };

  const provider = fixture.mutations.runProviderOperation(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, admittedVersion),
    "askAside",
    providerOperation(
      async (stories, start) => {
        admitted();
        await gate;
        await start();
        await stories.commitProviderEffect(STORY_ID, {
          kind: "aside",
          expectedAsideDocumentId,
          document: staleDocument
        });
        return staleDocument;
      },
      () => staleDocument
    )
  );
  await admittedP;

  await fixture.mutations.runLocal(
    requestFor(THIRD_MUTATION_ID, "c".repeat(64), admittedVersion),
    "clearAside",
    (story) => { story.asideDocumentId = null; }
  );
  release();
  await assert.rejects(provider, hasCode("conflict"));
  assert.equal(await fixture.stories.loadAsideDocument(STORY_ID), null);
});

test("a first admitted Aside answer cannot resurrect after clear before provider start", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-first-stale-clear-",
    {},
    undefined,
    { asideActivation: true }
  );
  await ensureRootPart(fixture.stories);
  const admittedVersion = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  let admitted!: () => void;
  const admittedP = new Promise<void>((resolve) => { admitted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "First?", answer: "Must not return." }]
  };

  const provider = fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, admittedVersion),
    "askAside",
    providerOperation(
      async (stories, start) => {
        const admittedStory = await stories.loadForMutation(STORY_ID);
        assert.equal(admittedStory.asideDocumentId, undefined);
        admitted();
        await gate;
        await start();
        await stories.commitProviderEffect(STORY_ID, {
          kind: "aside",
          expectedAsideDocumentId: admittedStory.asideDocumentId,
          document
        });
        return document;
      },
      () => document
    )
  );
  await admittedP;

  await fixture.mutations.runLocal(
    requestFor(OTHER_MUTATION_ID, OTHER_FINGERPRINT, admittedVersion),
    "clearAside",
    (story) => {
      assert.equal(story.asideDocumentId, undefined);
      story.asideDocumentId = null;
    }
  );
  assert.equal((await fixture.stories.load(STORY_ID)).asideDocumentId, null);

  release();
  await assert.rejects(provider, hasCode("conflict"));
  assert.equal(await fixture.stories.loadAsideDocument(STORY_ID), null);
});

test("a later stale Aside answer cannot replace the first committed answer", async (t) => {
  const fixture = await setup(
    t,
    "1667-aside-stale-answer-",
    {},
    undefined,
    { asideActivation: true }
  );
  await ensureRootPart(fixture.stories);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(() => new Promise<void>((resolve) => releases.push(resolve)));
  let admitted = 0;
  let firstAdmitted!: () => void;
  const firstAdmittedP = new Promise<void>((resolve) => { firstAdmitted = resolve; });
  let bothAdmitted!: () => void;
  const bothAdmittedP = new Promise<void>((resolve) => { bothAdmitted = resolve; });
  const documents = ["First.", "Stale second."].map((answer) => ({
    schemaVersion: 1 as const,
    notes: [{ question: "Which?", answer }]
  }));
  const run = (index: number, mutationId: string, fingerprint: string) =>
    fixture.mutations.runProviderOperation(
      requestFor(mutationId, fingerprint, version),
      "askAside",
      providerOperation(
        async (stories, start) => {
          admitted += 1;
          if (admitted === 1) firstAdmitted();
          if (admitted === 2) bothAdmitted();
          await gates[index];
          await start();
          await stories.commitProviderEffect(STORY_ID, {
            kind: "aside",
            expectedAsideDocumentId: undefined,
            document: documents[index]!
          });
          return documents[index]!;
        },
        () => documents[index]!
      )
    );

  const first = run(0, MUTATION_ID, FINGERPRINT);
  await firstAdmittedP;
  const second = run(1, OTHER_MUTATION_ID, OTHER_FINGERPRINT);
  await bothAdmittedP;
  releases[0]!();
  await first;
  releases[1]!();
  await assert.rejects(second, hasCode("conflict"));
  assert.equal(
    (await fixture.stories.loadAsideDocument(STORY_ID))?.notes[0]?.answer,
    "First."
  );
});

test("lost terminal reply replay returns the same Side Notes without a second commit", async (t) => {
  const fixture = await setup(t, "1667-aside-idem-", {}, undefined, { asideActivation: true });
  await ensureRootPart(fixture.stories);
  const version = (await fixture.stories.loadVersioned(STORY_ID)).aggregateVersion!;
  let commits = 0;
  const document = {
    schemaVersion: 1 as const,
    notes: [{ question: "Once?", answer: "Only once." }]
  };
  const work = providerOperation(
    async (stories, start) => {
      await start();
      commits += 1;
      await stories.commitProviderEffect(STORY_ID, {
        kind: "aside",
        expectedAsideDocumentId: undefined,
        document
      });
      return document;
    },
    () => document
  );
  await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    work
  );
  assert.equal(commits, 1);
  await fixture.mutations.runProviderOperation(
    requestFor(MUTATION_ID, FINGERPRINT, version),
    "askAside",
    work
  );
  assert.equal(commits, 1, "replay must not re-enter provider commit");
  const doc = await fixture.stories.loadAsideDocument(STORY_ID);
  assert.equal(doc?.notes.length, 1);
});
