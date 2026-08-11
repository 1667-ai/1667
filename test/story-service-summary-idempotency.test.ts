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
import { summaryTakePrompt } from "../server/summary-take.js";
import {
  executeWorkerMutation,
  parseWorkerMutation,
  preflightWorkerMutation
} from "../server/worker-mutations.js";
import { renderPromptPlan } from "../shared/prompt-plan.js";
import { estimateTokens } from "../shared/tokens.js";
import type { StoryNode } from "../shared/types.js";

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
  const originalRunProvider =
    service.mutationStore.runProviderOperation.bind(service.mutationStore);
  t.after(async () => {
    globalThis.fetch = originalFetch;
    service.mutationStore.runProviderOperation = originalRunProvider;
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
  service.mutationStore.runProviderOperation = (async (
    input: unknown,
    method,
    operation
  ) => await originalRunProvider(
    input,
    method,
    {
      ...operation,
      work: async (context) => await operation.work({
        ...context,
        stories: abortAfterPreparedEffect(context.stories, controller)
      })
    }
  )) as typeof service.mutationStore.runProviderOperation;

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
  assert.equal(typeof committed, "object");
  assert.ok(committed !== null);
  assert.equal(typeof committed.nodeId, "string");
  assert.equal(controller.signal.aborted, true);
  assert.equal(
    (await service.loadStory(story.id)).nodes.find(
      (node) => node.id === committed.nodeId
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
  assert.deepEqual(replayed, committed);
  assert.equal(requests, 1);
});

test("a summary narrowed to an earlier point commits that point and replays it identically on retry", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-summary-narrow-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = StoryService.withoutDiagnostics({ dataDir });
  await service.init();
  t.after(() => service.dispose());

  const initial = await service.getSettings();
  assert.equal(initial.dataFormat, 2);

  // Four parts, each big enough that the token gap between including three
  // and including four dwarfs the fixed prompt overhead (system prompt,
  // instructions, completion marker) — see server/summary-take.ts's
  // summaryTakePrompt. Computed from the real prompt builder rather than
  // estimated, so this fixture cannot drift from what the server itself
  // measures (issue #139).
  const title = "Narrowed retry";
  const texts = ["PART-ONE", "PART-TWO", "PART-THREE", "PART-FOUR"]
    .map((label) => `${label} ${"word ".repeat(500)}`.trim());
  const inputTokensFor = (count: number): number => {
    const parts = texts.slice(0, count).map((text) => ({ text })) as unknown as readonly StoryNode[];
    const prompt = summaryTakePrompt(title, parts, 50, "00000000");
    return renderPromptPlan(prompt).reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);
  };
  const input3 = inputTokensFor(3);
  const input4 = inputTokensFor(4);
  assert.ok(input4 - input3 > 100, "fixture needs a clear per-part token gap");
  const maxTokens = 50;
  const contextWindow = Math.ceil((input3 + maxTokens + 20) / 0.9);
  assert.ok(
    Math.floor(contextWindow * 0.9) - input4 < maxTokens,
    "fixture must not also leave room for all four parts"
  );

  await service.saveSettings({
    transportOperationId: crypto.randomUUID(),
    mutationId: createDurableMutationId(),
    expectedStateGeneration: initial.stateGeneration,
    document: applyEffectiveGenerationSettings(initial.document, {
      ...initial.effective,
      provider: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture",
      contextWindow,
      maxTokens
    })
  });

  let story = await service.createStory(title);
  story = await service.createNode(story.id, { parentId: null, text: texts[0]! });
  for (const text of texts.slice(1)) {
    story = await service.createNode(story.id, { parentId: story.path.at(-1)!.id, text });
  }
  const part3Id = story.path[2]!.id;

  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  let lastPrompt = "";
  globalThis.fetch = (async (request, init) => {
    requests += 1;
    const text = request instanceof Request
      ? await request.clone().text()
      : String(init?.body);
    const body = JSON.parse(text) as {
      messages: Array<{ role: string; content: string }>;
    };
    lastPrompt = body.messages.findLast((message) => message.role === "user")?.content ?? "";
    const marker = /\[\[summary-complete-[a-f0-9]+\]\]/.exec(lastPrompt)?.[0];
    assert.ok(marker);
    return openAiStream(`Narrowed recap.\n${marker}`);
  }) as typeof fetch;

  const input = {
    storyId: story.id,
    body: { nodeId: story.path.at(-1)!.id }
  };
  const summaryMutationId = createDurableMutationId();
  const expectedAggregateVersion = (
    await service.stories.loadVersioned(story.id)
  ).aggregateVersion!;

  const first = await runWorkerMutation(
    service,
    summaryMutationId,
    "createSummaryTake",
    input,
    new AbortController().signal,
    expectedAggregateVersion
  );
  assert.ok(first !== null);
  // The latest point that fits is part three's — parts one and two also fit
  // on their own (they are strictly smaller), so this pins down "latest",
  // not merely "an earlier point that works".
  assert.deepEqual(first.narrowedTo, { nodeId: part3Id, offset: null });
  assert.match(lastPrompt, /PART-THREE/);
  assert.doesNotMatch(lastPrompt, /PART-FOUR/);
  assert.equal(requests, 1);

  const committedNode = (await service.loadStory(story.id)).nodes
    .find((node) => node.id === first.nodeId);
  assert.equal(committedNode?.role, "summary");
  // The committed take's own point matches what was actually summarized,
  // not the point the request named.
  assert.equal(committedNode?.parentId, part3Id);

  const replayed = await runWorkerMutation(
    service,
    summaryMutationId,
    "createSummaryTake",
    input,
    new AbortController().signal,
    expectedAggregateVersion
  );
  assert.deepEqual(replayed, first);
  assert.equal(requests, 1);
  assert.equal(
    (await service.loadStory(story.id)).nodes.filter((node) => node.role === "summary").length,
    1
  );
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
