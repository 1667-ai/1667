import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
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
import {
  LEGACY_PREVIEW_DATA_MARKER,
  LEGACY_PREVIEW_DATA_MARKER_TEXT
} from "../server/data-directory-format.js";
import {
  GenerationResultError,
  ProviderError
} from "../server/errors.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import { applyEffectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import { formatGenerationSettingsV1 } from "../server/settings-v1-codec.js";
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
  let service = StoryService.withoutDiagnostics({ dataDir });
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

    service = StoryService.withoutDiagnostics({ dataDir });
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

test("direct rewrite deletion persists a definitive compatibility conflict", async (t) => {
  const { dataDir, service } = await legacyProviderService(
    t,
    "1667-direct-rewrite-deletion-"
  );
  let story = await service.createStory("Rewrite deletion");
  story = await service.createNode(story.id, {
    parentId: null,
    text: "The red door opened."
  });
  const root = story.path[0]!;
  const start = root.text.indexOf("red");
  const input = {
    storyId: story.id,
    nodeId: root.id,
    body: {
      start,
      end: start + 3,
      instruction: "Change the color.",
      expected: "red"
    }
  };
  const mutationId = createDurableMutationId();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = (async () => {
      requests += 1;
      await service.deleteStory(story.id);
      return openAiStream("blue");
    }) as typeof fetch;

    await assert.rejects(
      runCompatibilityWorkerMutation(
        service,
        mutationId,
        "rewriteNode",
        input
      ),
      (error: unknown) =>
        error instanceof GenerationResultError
        && error.code === "conflict"
        && /deleted while rewriting/i.test(error.message)
    );
    await assert.rejects(
      runCompatibilityWorkerMutation(
        service,
        mutationId,
        "rewriteNode",
        input
      ),
      hasCode("conflict")
    );
    assert.equal(requests, 1);
    const receipt = JSON.parse(await readFile(
      path.join(dataDir, "mutation-receipts", `${mutationId}.json`),
      "utf8"
    )) as { state?: unknown; failure?: { code?: unknown } };
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.failure?.code, "conflict");
  } finally {
    globalThis.fetch = originalFetch;
    await service.dispose();
  }
});

test("direct chapter-summary deletion persists a definitive compatibility conflict", async (t) => {
  const { dataDir, service } = await legacyProviderService(
    t,
    "1667-direct-chapter-deletion-"
  );
  let story = await service.createStory("Chapter deletion");
  story = await service.createNode(story.id, {
    parentId: null,
    text: "The first chapter ended."
  });
  const created = await service.createChapterBreak(
    story.id,
    story.path[0]!.id,
    ""
  );
  const input = {
    storyId: story.id,
    breakId: created.breakId
  };
  const mutationId = createDurableMutationId();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = (async (providerRequest, init) => {
      requests += 1;
      const requestBody = typeof init?.body === "string"
        ? init.body
        : providerRequest instanceof Request
          ? await providerRequest.clone().text()
          : "";
      const marker = /\[\[summary-complete-[a-f0-9]+\]\]/
        .exec(requestBody)?.[0];
      assert.ok(marker);
      await service.deleteStory(story.id);
      return openAiStream(`Closed chapter summary.\n${marker}`);
    }) as typeof fetch;

    await assert.rejects(
      runCompatibilityWorkerMutation(
        service,
        mutationId,
        "summarizeChapter",
        input
      ),
      (error: unknown) =>
        error instanceof GenerationResultError
        && error.code === "conflict"
        && /deleted while its chapter summary/i.test(error.message)
    );
    await assert.rejects(
      runCompatibilityWorkerMutation(
        service,
        mutationId,
        "summarizeChapter",
        input
      ),
      hasCode("conflict")
    );
    assert.equal(requests, 1);
    const receipt = JSON.parse(await readFile(
      path.join(dataDir, "mutation-receipts", `${mutationId}.json`),
      "utf8"
    )) as { state?: unknown; failure?: { code?: unknown } };
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.failure?.code, "conflict");
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

async function runCompatibilityWorkerMutation<M extends MutatingWorkerMethod>(
  service: StoryService,
  mutationId: string,
  method: M,
  value: unknown
): Promise<WorkerOutput<M>> {
  const input = parseWorkerMutation(method, value, WORKER_PROTOCOL_VERSION);
  return await service.runMutation(
    mutationId,
    method,
    value,
    (plan) => executeWorkerMutation(service, input, plan, {
      onDelta: () => {},
      signal: new AbortController().signal
    }),
    WORKER_PROTOCOL_VERSION,
    () => {}
  );
}

async function legacyProviderService(
  t: test.TestContext,
  prefix: string
): Promise<{ dataDir: string; service: StoryService }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(
    path.join(dataDir, LEGACY_PREVIEW_DATA_MARKER),
    LEGACY_PREVIEW_DATA_MARKER_TEXT,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(dataDir, "settings.json"),
    formatGenerationSettingsV1({
      provider: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture",
      apiKeyEnv: null,
      temperature: 0,
      maxTokens: 128,
      systemPrompt: "Write coherent prose.",
      contextWindow: 4096
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  return { dataDir, service };
}

function openAiStream(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      choices: [{
        delta: { content: text },
        finish_reason: null
      }]
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  );
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object"
    && "code" in error
    && (error as { code: unknown }).code === code;
}
