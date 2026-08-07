import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import {
  isManifestOnlyDurabilityEligible,
  type MutatingWorkerMethod,
  type WorkerOutput
} from "../shared/worker-protocol.js";
import { MAX_FACTS } from "../shared/types.js";
import { initializeProject } from "../server/project-discovery.js";
import { StoryService } from "../server/story-service.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import {
  executeWorkerMutation,
  parseWorkerMutation
} from "../server/worker-mutations.js";

const encoder = new TextEncoder();

test("imports keep the full receipt tier that preserves their performed plan", () => {
  assert.equal(isManifestOnlyDurabilityEligible("importLorebook", {
    storyId: "story",
    archiveBytes: new Uint8Array()
  }), false);
  assert.equal(isManifestOnlyDurabilityEligible("importCard", {
    storyId: "story",
    cardBytes: new Uint8Array()
  }), false);
});

// The crash window from old-repo #321: the story transaction committed, and
// the process stopped before the outer receipt completed. The rewrite keeps
// everything the crash would keep — including a preserved artifact — and
// drops exactly what the crash would drop.
async function reopenReceipt(
  dataDir: string,
  mutationIdValue: string,
  options: { dropArtifact?: boolean } = {}
): Promise<void> {
  const file = path.join(dataDir, "mutation-receipts", `${mutationIdValue}.json`);
  const receipt = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  receipt.state = "pending";
  delete receipt.result;
  if (options.dropArtifact === true) delete receipt.artifact;
  await writeFile(file, `${JSON.stringify(receipt)}\n`);
}

/** Drive one mutation through the worker boundary the way the embedded
 * worker and the HTTP transport do: the outer receipt wraps the handler, and
 * the handler passes the canonical story mutation request to the service. */
async function runImportMutation<M extends MutatingWorkerMethod>(
  service: StoryService,
  mutationIdValue: string,
  method: M,
  value: unknown,
  expectedAggregateVersion: StoryAggregateVersion
): Promise<WorkerOutput<M>> {
  const input = parseWorkerMutation(method, value);
  return await service.runMutation(
    mutationIdValue,
    method,
    value,
    (plan) => executeWorkerMutation(service, input, plan, {
      onDelta: () => {},
      signal: new AbortController().signal,
      storyMutationRequest: {
        transportOperationId: crypto.randomUUID(),
        mutationId: mutationIdValue,
        fingerprint: mutationFingerprint(method, value),
        scope: `story:${(value as { storyId: string }).storyId}`,
        expectedAggregateVersion
      }
    }),
    undefined,
    () => undefined
  );
}

function lorebookBytes(entryCount: number): Uint8Array {
  return encoder.encode(JSON.stringify({
    lorebookVersion: 6,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      enabled: true,
      text: `The lantern rule number ${index}.`,
      displayName: `Rule ${index}`,
      forceActivation: true
    }))
  }));
}

function cardBytes(): Uint8Array {
  return encoder.encode(JSON.stringify({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Maren",
      description: "Maren keeps the light.",
      personality: "quiet, exact",
      scenario: "A lighthouse on the north cape.",
      character_book: {
        entries: [
          { content: "The pass closes in winter.", name: "Weather", keys: ["storm"] },
          { content: "The keeper never leaves the light.", comment: "Premise", constant: true }
        ]
      }
    }
  }));
}

async function openService(root: string): Promise<StoryService> {
  const project = await initializeProject(root);
  const service = StoryService.withoutDiagnostics({ dataDir: project.directory });
  await service.init();
  return service;
}

async function storyWithRoom(
  service: StoryService,
  room: number
): Promise<{ storyId: string; version: StoryAggregateVersion }> {
  const story = await service.createStory("Import target");
  if (room < MAX_FACTS) {
    await service.createFact(story.id, {
      facts: Array.from(
        { length: MAX_FACTS - room },
        (_, index) => ({ text: `Room filler ${index}.` })
      )
    });
  }
  const loaded = await service.loadStory(story.id);
  assert.ok(loaded.aggregateVersion, "story must carry an aggregate version");
  return { storyId: story.id, version: loaded.aggregateVersion };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object" && "code" in error
    && (error as { code: unknown }).code === code;
}

test("a retried lorebook import repeats the plan the import performed, across a restart", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-lorebook-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let service = await openService(root);
  const { storyId, version } = await storyWithRoom(service, 2);
  // Three entries against a room of two: the import fills the story's
  // remaining room, which is exactly the case #321 names as guaranteed to
  // misreport — a recomputed retry plan would find a room of zero.
  const value = { storyId, archiveBytes: lorebookBytes(3) };
  const importId = createDurableMutationId();

  const first = await runImportMutation(service, importId, "importLorebook", value, version);
  assert.equal(first.importResult.facts.length, 2);
  assert.ok(
    first.importResult.fidelity.some((line) => line.includes("did not fit")),
    "the first report must name the entry the room refused"
  );
  assert.equal(first.payload.facts.length, MAX_FACTS);
  await reopenReceipt(service.dataDir, importId);
  await service.dispose();

  service = await openService(root);
  try {
    const retried = await runImportMutation(
      service,
      importId,
      "importLorebook",
      { storyId, archiveBytes: lorebookBytes(3) },
      version
    );
    assert.deepEqual(retried.importResult, first.importResult);
    // No duplicate Facts: the story after the retry is the story the first
    // commit produced, fact for fact and id for id.
    assert.deepEqual(retried.payload.facts, first.payload.facts);
    assert.equal(retried.payload.updatedAt, first.payload.updatedAt);

    // The receipt completed on the retry; a further replay resolves from it
    // and must answer the same plan beside a fresh story payload.
    const replayed = await runImportMutation(
      service,
      importId,
      "importLorebook",
      { storyId, archiveBytes: lorebookBytes(3) },
      version
    );
    assert.deepEqual(replayed.importResult, first.importResult);
    assert.deepEqual(replayed.payload.facts, first.payload.facts);
  } finally {
    await service.dispose();
  }
});

test("a retried card import repeats the plan the import performed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-card-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = await openService(root);
  try {
    // Room for one: the card's own sections convert to more Facts than fit,
    // so the plan is bounded by the room and a recomputed retry would report
    // a different, smaller import.
    const { storyId, version } = await storyWithRoom(service, 1);
    const value = { storyId, cardBytes: cardBytes() };
    const importId = createDurableMutationId();

    const first = await runImportMutation(service, importId, "importCard", value, version);
    assert.equal(first.plan.facts.length, 1);
    assert.ok(
      first.plan.fidelity.some((line) => line.includes("did not fit")),
      "the first report must name the Facts the room refused"
    );
    await reopenReceipt(service.dataDir, importId);

    const retried = await runImportMutation(service, importId, "importCard", value, version);
    assert.deepEqual(retried.plan, first.plan);
    assert.deepEqual(retried.payload.facts, first.payload.facts);
    assert.equal(retried.payload.facts.length, MAX_FACTS);
  } finally {
    await service.dispose();
  }
});

test("a retried import into a full story repeats the empty plan exactly", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-full-story-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = await openService(root);
  try {
    const { storyId, version } = await storyWithRoom(service, 0);
    const value = { storyId, archiveBytes: lorebookBytes(2) };
    const importId = createDurableMutationId();

    const first = await runImportMutation(service, importId, "importLorebook", value, version);
    assert.equal(first.importResult.facts.length, 0);
    assert.ok(first.importResult.fidelity.some((line) => line.includes("0 facts imported")));
    await reopenReceipt(service.dataDir, importId);

    const retried = await runImportMutation(service, importId, "importLorebook", value, version);
    assert.deepEqual(retried.importResult, first.importResult);
    assert.equal(retried.payload.facts.length, MAX_FACTS);
    assert.equal(retried.payload.updatedAt, first.payload.updatedAt);
  } finally {
    await service.dispose();
  }
});

test("a committed import replayed without its preserved plan refuses instead of recomputing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-legacy-import-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = await openService(root);
  try {
    const { storyId, version } = await storyWithRoom(service, 2);
    const value = { storyId, archiveBytes: lorebookBytes(3) };
    const importId = createDurableMutationId();

    const first = await runImportMutation(service, importId, "importLorebook", value, version);
    assert.equal(first.payload.facts.length, MAX_FACTS);
    // A receipt a build before import-plan preservation left behind: the
    // import committed, and no plan was preserved for it.
    await reopenReceipt(service.dataDir, importId, { dropArtifact: true });

    await assert.rejects(
      runImportMutation(service, importId, "importLorebook", value, version),
      hasCode("mutation_outcome_unknown")
    );
    const after = await service.loadStory(storyId);
    assert.deepEqual(after.facts, first.payload.facts);
  } finally {
    await service.dispose();
  }
});
