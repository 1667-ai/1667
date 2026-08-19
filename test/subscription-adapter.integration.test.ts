import assert from "node:assert/strict";
import test from "node:test";
import {
  type Context,
  type Model
} from "@earendil-works/pi-ai";
import {
  adjustMaxTokensForThinking,
  clampMaxTokensToContext
} from "@earendil-works/pi-ai/api/simple-options";
import { ProviderError } from "../server/errors.js";
import { streamCompletion, type StreamOutcome } from "../server/providers.js";
import { createSubscriptionCredentialStore } from "../server/subscription-credential-store.js";
import { createSubscriptionModels } from "../server/subscription-models.js";
import type { GenerationRecordCollector } from "../server/generation-record-capture.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import {
  ACCESS,
  PROMPT,
  collect,
  fakeModels,
  modelFor,
  oauth,
  subscriptionSettings,
  successfulStream,
  temporaryDirectory
} from "./subscription-adapter-test-helpers.js";

test("subscription adapter maps PromptPlan and fixed provider options", async (t) => {
  for (const fixture of [
    {
      protocol: "openai-codex-responses" as const,
      provider: "openai-compatible" as const,
      providerId: "openai-codex" as const,
      api: "openai-codex-responses" as const
    },
    {
      protocol: "anthropic-subscription-messages" as const,
      provider: "anthropic" as const,
      providerId: "anthropic" as const,
      api: "anthropic-messages" as const
    }
  ]) {
    const secretsDir = await temporaryDirectory(t, `1667-subscription-${fixture.providerId}-`);
    const credentials = createSubscriptionCredentialStore(secretsDir);
    await credentials.modify(fixture.providerId, async () => oauth(ACCESS));
    const model = modelFor(fixture.providerId, fixture.api);
    let seenContext: Context | undefined;
    let seenOptions: Record<string, unknown> | undefined;
    const models = fakeModels(model, (context, options) => {
      seenContext = context;
      seenOptions = options;
      return successfulStream(model, fixture.api === "anthropic-messages");
    });
    const settings = subscriptionSettings(fixture.protocol, fixture.provider, fixture.api, credentials, models);
    const outcome: StreamOutcome = { finishReason: null, providerTerminal: false };
    const generationRecord: GenerationRecordCollector = { effective: null };
    const reasoning: string[] = [];
    const output = await collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
      outcome,
      generationRecord,
      onReasoning: async (delta) => { reasoning.push(delta.text); }
    }));

    assert.equal(output, "answer");
    assert.equal(outcome.providerTerminal, true);
    assert.equal(outcome.finishReason, "stop");
    assert.equal(seenContext?.systemPrompt, "System.");
    assert.deepEqual(seenContext?.messages.map((message) => message.role), ["user"]);
    assert.deepEqual(seenContext?.tools, []);
    assert.equal(seenOptions?.toolChoice, "none");
    assert.equal(seenOptions?.maxTokens, 128);
    assert.equal(seenOptions?.apiKey, ACCESS);
    const effective = generationRecord.effective;
    assert.equal(effective?.wireProtocol, fixture.protocol);
    const fields = new Map(effective?.fields.map((field) => [field.field, field.value]));
    assert.equal(fields.get("max_tokens"), fixture.api === "anthropic-messages" ? 128 : undefined);
    assert.equal(
      fields.get(fixture.api === "anthropic-messages" ? "tool_choice.type" : "tool_choice"),
      "none"
    );
    if (fixture.api === "anthropic-messages") {
      assert.deepEqual(reasoning, ["thinking"]);
    } else {
      assert.deepEqual(reasoning, []);
    }
  }
});

test("Anthropic plan effort uses Pi adaptive and budget model capabilities", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-anthropic-effort-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const catalog = createSubscriptionModels(credentials);

  const adaptive = catalog.getModel("anthropic", "claude-sonnet-4-6");
  assert.ok(adaptive);
  let adaptiveOptions: Record<string, unknown> | undefined;
  await collect(streamCompletion(subscriptionSettings(
    "anthropic-subscription-messages",
    "anthropic",
    "anthropic-messages",
    credentials,
    fakeModels(adaptive as Model<"anthropic-messages">, (_context, options) => {
      adaptiveOptions = options;
      return successfulStream(adaptive as Model<"anthropic-messages">, true);
    }),
    {},
    "low",
    2_048
  ), PROMPT, new AbortController().signal));
  assert.equal(adaptiveOptions?.thinkingEnabled, true);
  assert.equal(adaptiveOptions?.effort, "low");
  assert.equal(adaptiveOptions?.thinkingBudgetTokens, undefined);
  assert.equal(adaptiveOptions?.maxTokens, 2_048);

  const budget = catalog.getModel("anthropic", "claude-haiku-4-5");
  assert.ok(budget);
  for (const fixture of [
    { effort: "low" as const, thinking: 2_048, total: 4_096 },
    { effort: "medium" as const, thinking: 8_192, total: 10_240 },
    { effort: "high" as const, thinking: 16_384, total: 18_432 }
  ]) {
    let budgetOptions: Record<string, unknown> | undefined;
    await collect(streamCompletion(subscriptionSettings(
      "anthropic-subscription-messages",
      "anthropic",
      "anthropic-messages",
      credentials,
      fakeModels(budget as Model<"anthropic-messages">, (_context, options) => {
        budgetOptions = options;
        return successfulStream(budget as Model<"anthropic-messages">, true);
      }),
      {},
      fixture.effort,
      2_048
    ), PROMPT, new AbortController().signal));
    assert.equal(budgetOptions?.thinkingEnabled, true);
    assert.equal(budgetOptions?.effort, undefined);
    assert.equal(budgetOptions?.thinkingBudgetTokens, fixture.thinking);
    assert.equal(budgetOptions?.maxTokens, fixture.total);
  }
});

test("Claude plan clamps profile output to the pinned catalog model cap", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-anthropic-output-cap-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const catalog = createSubscriptionModels(credentials);
  const adaptive = catalog.getModel("anthropic", "claude-sonnet-4-6") as Model<"anthropic-messages"> | undefined;
  const budget = catalog.getModel("anthropic", "claude-haiku-4-5") as Model<"anthropic-messages"> | undefined;
  assert.ok(adaptive);
  assert.ok(budget);

  for (const fixture of [
    { model: adaptive, effort: "default" as const },
    { model: adaptive, effort: "off" as const },
    { model: adaptive, effort: "low" as const },
    { model: budget, effort: "low" as const }
  ]) {
    let seenOptions: Record<string, unknown> | undefined;
    const requestedMaxTokens = fixture.model.maxTokens + 10_000;
    await collect(streamCompletion(subscriptionSettings(
      "anthropic-subscription-messages",
      "anthropic",
      "anthropic-messages",
      credentials,
      fakeModels(fixture.model, (_context, options) => {
        seenOptions = options;
        return successfulStream(fixture.model, true);
      }),
      {},
      fixture.effort,
      requestedMaxTokens
    ), PROMPT, new AbortController().signal));

    assert.equal(seenOptions?.maxTokens, fixture.model.maxTokens);
    if (fixture.effort === "default" || fixture.effort === "off") {
      assert.equal(seenOptions?.thinkingEnabled, false);
    } else if (fixture.model.compat?.forceAdaptiveThinking === true) {
      assert.equal(seenOptions?.thinkingEnabled, true);
      assert.equal(seenOptions?.effort, "low");
    } else {
      assert.equal(seenOptions?.thinkingEnabled, true);
      assert.ok(
        (seenOptions?.thinkingBudgetTokens as number) <= fixture.model.maxTokens - 1_024
      );
    }
  }
});

test("Anthropic budget thinking reserves output within the remaining context", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-anthropic-context-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const catalog = createSubscriptionModels(credentials);
  const catalogModel = catalog.getModel("anthropic", "claude-haiku-4-5");
  assert.ok(catalogModel);
  const model = {
    ...catalogModel,
    contextWindow: 8_192
  } as Model<"anthropic-messages">;
  let seenContext: Context | undefined;
  let seenOptions: Record<string, unknown> | undefined;
  const models = fakeModels(model, (context, options) => {
    seenContext = context;
    seenOptions = options;
    return successfulStream(model, true);
  });
  const nearLimitPrompt: PromptPlan = {
    operation: "continue",
    turns: [{
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "request",
        text: "near ".repeat(2_000),
        boundaryAfter: "none"
      }]
    }]
  };

  await collect(streamCompletion(subscriptionSettings(
    "anthropic-subscription-messages",
    "anthropic",
    "anthropic-messages",
    credentials,
    models,
    {},
    "low",
    2_048
  ), nearLimitPrompt, new AbortController().signal));

  assert.ok(seenContext);
  assert.ok(seenOptions);
  const admittedMaxTokens = clampMaxTokensToContext(model, seenContext, 2_048);
  const adjusted = adjustMaxTokensForThinking(admittedMaxTokens, model.maxTokens, "low");
  const expectedMaxTokens = clampMaxTokensToContext(model, seenContext, adjusted.maxTokens);
  assert.equal(seenOptions.maxTokens, expectedMaxTokens);
  assert.equal(
    seenOptions.thinkingBudgetTokens,
    Math.min(adjusted.thinkingBudget, Math.max(0, expectedMaxTokens - 1_024))
  );
  assert.ok(expectedMaxTokens < adjusted.maxTokens);
  assert.ok((seenOptions.thinkingBudgetTokens as number) < 2_048);
  assert.equal(
    seenOptions.maxTokens,
    clampMaxTokensToContext(model, seenContext, seenOptions.maxTokens as number)
  );
});

test("subscription story sampling is rejected before provider start", async (t) => {
  for (const fixture of [
    {
      protocol: "openai-codex-responses" as const,
      provider: "openai-compatible" as const,
      providerId: "openai-codex" as const,
      api: "openai-codex-responses" as const
    },
    {
      protocol: "anthropic-subscription-messages" as const,
      provider: "anthropic" as const,
      providerId: "anthropic" as const,
      api: "anthropic-messages" as const
    }
  ]) {
    for (const storySampling of [
      { phraseBias: [{ phrase: "forbidden", weight: -100 }], bannedStrings: [] },
      { phraseBias: [], bannedStrings: ["forbidden"] }
    ]) {
      const secretsDir = await temporaryDirectory(
        t,
        `1667-subscription-story-sampling-${fixture.providerId}-${storySampling.phraseBias.length ? "phrase" : "banned"}-`
      );
      const credentials = createSubscriptionCredentialStore(secretsDir);
      await credentials.modify(fixture.providerId, async () => oauth(ACCESS));
      const model = modelFor(fixture.providerId, fixture.api);
      let streamCalls = 0;
      const models = fakeModels(model, () => {
        streamCalls += 1;
        return successfulStream(model, fixture.api === "anthropic-messages");
      });
      const settings = subscriptionSettings(
        fixture.protocol,
        fixture.provider,
        fixture.api,
        credentials,
        models
      );
      let providerStarted = false;
      await assert.rejects(
        collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
          providerStarted: () => { providerStarted = true; },
          storySampling
        })),
        (error: unknown) => error instanceof ProviderError
          && error.message === "Configured sampling parameter phrase bias is unavailable: Not supported by this provider."
      );
      assert.equal(providerStarted, false);
      assert.equal(streamCalls, 0);
    }
  }
});

test("subscription context uses the canonical provider prompt lowering", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-prompt-lowering-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  const model = modelFor("openai-codex", "openai-codex-responses");
  let seenContext: Context | undefined;
  const models = fakeModels(model, (context) => {
    seenContext = context;
    return successfulStream(model, false);
  });
  const settings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    models
  );
  const prompt: PromptPlan = {
    operation: "continue",
    turns: [
      {
        role: "user",
        blocks: [{
          stability: "stable",
          kind: "authors-note",
          text: "Keep the tone spare.",
          boundaryAfter: "none"
        }]
      },
      {
        role: "user",
        blocks: [{
          stability: "volatile",
          kind: "request",
          text: "Continue.",
          boundaryAfter: "none"
        }]
      }
    ]
  };
  await collect(streamCompletion(settings, prompt, new AbortController().signal));
  assert.equal(seenContext?.messages[0]?.content, "Keep the tone spare.\n\nContinue.");
});

test("providerStarted starts response-header timing, while total timing starts earlier", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-provider-start-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  const model = modelFor("openai-codex", "openai-codex-responses");
  let transportStarted = false;
  let release!: () => void;
  const markerBlocked = new Promise<void>((resolve) => { release = resolve; });
  let markerReached!: () => void;
  const marker = new Promise<void>((resolve) => { markerReached = resolve; });
  const models = fakeModels(model, () => {
    transportStarted = true;
    return successfulStream(model, false);
  });
  const settings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    models,
    { responseHeaderMs: 10 }
  );
  const pending = collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
    providerStarted: async () => {
      markerReached();
      await new Promise((resolve) => setTimeout(resolve, 35));
      await markerBlocked;
    }
  }));
  await marker;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportStarted, false);
  release();
  assert.equal(await pending, "answer");
  assert.equal(transportStarted, true);

  const totalSettings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    fakeModels(model, () => successfulStream(model, false)),
    { responseHeaderMs: 10, totalMs: 100 }
  );
  await assert.rejects(
    collect(streamCompletion(totalSettings, PROMPT, new AbortController().signal, {
      providerStarted: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })),
    (error: unknown) => error instanceof ProviderError
      && error.timeout === "provider-total"
  );
});

test("providerStarted gate settles on caller cancellation", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-provider-cancel-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  const model = modelFor("openai-codex", "openai-codex-responses");
  let transportStarted = false;
  let markerReached!: () => void;
  const marker = new Promise<void>((resolve) => { markerReached = resolve; });
  const settings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    fakeModels(model, () => {
      transportStarted = true;
      return successfulStream(model, false);
    })
  );
  const controller = new AbortController();
  const pending = collect(streamCompletion(settings, PROMPT, controller.signal, {
    providerStarted: async () => {
      markerReached();
      await new Promise<void>(() => undefined);
    }
  }));
  await marker;
  controller.abort(new Error("cancelled while provider start was gated"));
  await assert.rejects(pending, /cancelled while provider start was gated/);
  assert.equal(transportStarted, false);
});
