import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableMutationId } from "../shared/durable-mutation-id.js";
import type {
  MutatingWorkerMethod,
  WorkerOutput
} from "../shared/worker-protocol.js";
import type { StoryAggregateVersion } from "../shared/story-aggregate-version.js";
import type { ProviderMutationMethod } from "../server/mutation-ledger-types.js";
import { mutationFingerprint } from "../server/mutation-receipts.js";
import { applyEffectiveGenerationSettings } from "../server/settings-v2-conversion.js";
import type {
  ProviderStoryEffectByMethod,
  ProviderStoryEffectValue
} from "../server/story-provider-effect.js";
import type { ProviderStoryRuntime } from "../server/story-mutation-runtime.js";
import type { StoryMutationStore } from "../server/story-mutation-store.js";
import { StoryService } from "../server/story-service.js";
import {
  executeWorkerMutation,
  parseWorkerMutation,
  preflightWorkerMutation
} from "../server/worker-mutations.js";

class SummaryIdempotencyService extends StoryService {
  get mutationStore(): StoryMutationStore {
    return this.storyMutations;
  }
}

test("summary cancellation after effect preparation replays the committed node", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-summary-prepared-cancel-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new SummaryIdempotencyService({
    dataDir,
    diagnostics: "disabled"
  });
  await service.init();
  const originalFetch = globalThis.fetch;
  const originalRunProvider = service.mutationStore.runProvider.bind(
    service.mutationStore
  );
  t.after(async () => {
    globalThis.fetch = originalFetch;
    service.mutationStore.runProvider = originalRunProvider;
    await service.dispose();
  });

  const initial = await service.getSettings();
  assert.equal(initial.dataFormat, 2);
  await service.saveSettings({
    transportOperationId: crypto.randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: initial.stateGeneration,
    document: applyEffectiveGenerationSettings(initial.document, {
      ...initial.effective,
      provider: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture"
    })
  });
  let story = await service.createStory("Prepared summary cancellation");
  story = await service.createNode(story.id, {
    parentId: null,
    text: "A detailed source for the durable summary."
  });

  const controller = new AbortController();
  service.mutationStore.runProvider = (async <
    Method extends ProviderMutationMethod,
    Value
  >(
    input: unknown,
    method: Method,
    work: (
      stories: ProviderStoryRuntime<Method>,
      providerStarted: () => Promise<void>
    ) => Promise<Value>,
    replayValue: () => Value
  ) => await originalRunProvider(
    input,
    method,
    async (stories, providerStarted) => await work(
      abortAfterPreparedEffect(stories, controller),
      providerStarted
    ),
    replayValue
  )) as typeof service.mutationStore.runProvider;

  let requests = 0;
  globalThis.fetch = (async (request, init) => {
    requests += 1;
    const text = request instanceof Request
      ? await request.clone().text()
      : String(init?.body);
    const body = JSON.parse(text) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages.findLast(
      (message) => message.role === "user"
    )?.content ?? "";
    const marker = /\[\[summary-complete-[a-f0-9]+\]\]/.exec(prompt)?.[0];
    assert.ok(marker);
    return openAiStream(`Durable recap.\n${marker}`);
  }) as typeof fetch;

  const input = {
    storyId: story.id,
    body: { nodeId: story.nodes[0]!.id }
  };
  const summaryMutationId = createDurableMutationId();
  const expectedAggregateVersion = (
    await service.stories.loadVersioned(story.id)
  ).aggregateVersion!;
  const committed = await runWorkerMutation(
    service,
    summaryMutationId,
    "createSummaryTake",
    input,
    controller.signal,
    expectedAggregateVersion
  );
  assert.equal(typeof committed, "string");
  assert.equal(controller.signal.aborted, true);
  assert.equal(
    (await service.loadStory(story.id)).nodes.find(
      (node) => node.id === committed
    )?.role,
    "summary"
  );

  const replayed = await runWorkerMutation(
    service,
    summaryMutationId,
    "createSummaryTake",
    input,
    new AbortController().signal,
    expectedAggregateVersion
  );
  assert.equal(replayed, committed);
  assert.equal(requests, 1);
});

function abortAfterPreparedEffect<Method extends ProviderMutationMethod>(
  stories: ProviderStoryRuntime<Method>,
  controller: AbortController
): ProviderStoryRuntime<Method> {
  return {
    loadForMutation: async (id) => await stories.loadForMutation(id),
    hydratePath: async (story, nodeId) =>
      await stories.hydratePath(story, nodeId),
    commitProviderEffect: async <
      Effect extends ProviderStoryEffectByMethod[Method]
    >(
      id: string,
      effect: Effect
    ): Promise<ProviderStoryEffectValue<Effect>> => {
      const value = await stories.commitProviderEffect(id, effect);
      controller.abort();
      return value;
    }
  };
}

async function runWorkerMutation<M extends MutatingWorkerMethod>(
  service: StoryService,
  mutationIdValue: string,
  method: M,
  value: unknown,
  signal: AbortSignal = new AbortController().signal,
  expectedAggregateVersion?: StoryAggregateVersion
): Promise<WorkerOutput<M>> {
  const input = parseWorkerMutation(method, value);
  return await service.runMutation(
    mutationIdValue,
    method,
    input,
    (plan) => executeWorkerMutation(service, input, plan, {
      onDelta: () => {},
      signal,
      ...(expectedAggregateVersion === undefined
        ? {}
        : {
            storyMutationRequest: {
              transportOperationId: crypto.randomUUID(),
              mutationId: mutationIdValue,
              fingerprint: mutationFingerprint(method, value),
              scope: `story:${valueStoryId(value)}` as const,
              expectedAggregateVersion
            }
          })
    }),
    undefined,
    (plan) => expectedAggregateVersion === undefined
      ? preflightWorkerMutation(service, input, plan)
      : undefined
  );
}

function openAiStream(text: string): Response {
  return new Response(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: text }, finish_reason: null }]
    })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  );
}

function valueStoryId(value: unknown): string {
  assert.ok(value !== null && typeof value === "object" && "storyId" in value);
  const storyId = value.storyId;
  assert.ok(typeof storyId === "string");
  return storyId;
}
