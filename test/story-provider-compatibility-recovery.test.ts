import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import {
  WORKER_PROTOCOL_VERSION,
  type MutatingWorkerMethod,
  type WorkerOutput
} from "../shared/worker-protocol.js";
import { ProviderError } from "../server/errors.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import { applyEffectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import { StoryService } from "../server/story-service.js";
import {
  executeWorkerMutation,
  parseWorkerMutation
} from "../server/worker-mutations.js";

test("provider-uncertain retry replays the durable Q terminal error", async (t) => {
  const dataDir = await mkdtemp(path.join(
    tmpdir(),
    "1667-provider-terminal-error-recovery-"
  ));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let service = new StoryService({ dataDir });
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    await service.init();
    const initial = await service.getSettings();
    assert.equal(initial.dataFormat, 2);
    const document = applyEffectiveGenerationSettings(initial.document, {
      ...initial.effective,
      provider: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture"
    });
    await service.saveSettings({
      transportOperationId: crypto.randomUUID(),
      mutationId: createDurableMutationId(),
      expectedStateGeneration: initial.stateGeneration,
      document
    });
    let story = await service.createStory("Terminal error recovery");
    story = await service.createNode(story.id, {
      parentId: null,
      text: "A detailed opening."
    });
    story = await service.loadStory(story.id);
    assert.notEqual(story.aggregateVersion, undefined);
    const expectedVersion = story.aggregateVersion!;
    const input = { id: story.id, expectedTitle: story.title };
    const providerMutationId = createDurableMutationId();
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{"error":"rejected"}', {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    await assert.rejects(
      runQWorkerMutation(
        service,
        providerMutationId,
        "autonameStory",
        input,
        story.id,
        expectedVersion
      ),
      (error: unknown) =>
        error instanceof ProviderError && error.status === 400
    );

    const receiptFile = path.join(
      service.dataDir,
      "mutation-receipts",
      `${providerMutationId}.json`
    );
    const interrupted = JSON.parse(
      await readFile(receiptFile, "utf8")
    ) as Record<string, unknown>;
    interrupted.state = "provider_started";
    delete interrupted.failure;
    delete interrupted.result;
    await writeFile(receiptFile, `${JSON.stringify(interrupted)}\n`);
    await service.dispose();

    service = new StoryService({ dataDir });
    await service.init();
    await assert.rejects(
      runQWorkerMutation(
        service,
        providerMutationId,
        "autonameStory",
        input,
        story.id,
        expectedVersion
      ),
      hasCode("provider_failure")
    );
    assert.equal(requests, 1);
    const recovered = JSON.parse(
      await readFile(receiptFile, "utf8")
    ) as {
      state?: unknown;
      failure?: { code?: unknown };
    };
    assert.equal(recovered.state, "failed");
    assert.equal(recovered.failure?.code, "provider_failure");
  } finally {
    globalThis.fetch = originalFetch;
    await service.dispose();
  }
});

async function runQWorkerMutation<M extends MutatingWorkerMethod>(
  service: StoryService,
  mutationId: string,
  method: M,
  value: unknown,
  storyId: string,
  expectedAggregateVersion: StoryAggregateVersion
): Promise<WorkerOutput<M>> {
  const input = parseWorkerMutation(method, value, WORKER_PROTOCOL_VERSION);
  const fingerprint = mutationFingerprint(
    method,
    value,
    WORKER_PROTOCOL_VERSION
  );
  return await service.runMutation(
    mutationId,
    method,
    value,
    (plan) => executeWorkerMutation(service, input, plan, {
      onDelta: () => {},
      signal: new AbortController().signal,
      storyMutationRequest: {
        transportOperationId: "compatibility-recovery-test",
        mutationId,
        fingerprint,
        scope: `story:${storyId}` as const,
        expectedAggregateVersion
      }
    }),
    WORKER_PROTOCOL_VERSION,
    () => {}
  );
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === code;
}
