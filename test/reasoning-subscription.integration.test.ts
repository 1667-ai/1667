import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { ProviderError } from "../server/errors.js";
import { streamCompletion } from "../server/providers.js";
import {
  attachProviderRuntime,
  providerRuntimeFor
} from "../server/provider-runtime.js";
import { createSubscriptionCredentialStore } from "../server/subscription-credential-store.js";
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

test("ChatGPT plan omits an existing stored temperature from its payload", async (t) => {
  const directory = await temporaryDirectory(t, "1667-reasoning-subscription-openai-");
  const credentials = createSubscriptionCredentialStore(directory);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  const model = modelFor("openai-codex", "openai-codex-responses");
  let seen: Record<string, unknown> | undefined;
  let payload: Record<string, unknown> | undefined;
  const models = fakeModels(model, (_context, options) => {
    seen = options;
    return successfulStream(model, false);
  }, undefined, (value) => { payload = value; });
  const legacy = subscriptionSettings(
    "openai-codex-responses", "openai-compatible", "openai-codex-responses",
    credentials, models
  );
  const runtime = providerRuntimeFor(legacy);
  const settings = attachProviderRuntime(
    { ...legacy, model: "gpt-5.6-sol", temperature: 0.4 },
    { ...runtime, effort: "default", thinkingMode: "off" }
  );
  assert.equal(
    await collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
    "answer"
  );
  assert.equal(seen?.reasoningEffort, "none");
  assert.equal(seen?.temperature, undefined);
  assert.equal("temperature" in (payload ?? {}), false);
  assert.equal(settings.temperature, 0.4);
});

test("Claude plan lowers an existing stored temperature by model and reasoning capability", async (t) => {
  const directory = await temporaryDirectory(t, "1667-reasoning-subscription-anthropic-temperature-");
  const credentials = createSubscriptionCredentialStore(directory);
  await credentials.modify("anthropic", async () => oauth(ACCESS));

  for (const fixture of [
    {
      model: "claude-sonnet-5",
      thinkingMode: "default" as const,
      withThinking: true,
      supportsTemperature: true,
      expectedTemperature: false
    },
    {
      model: "claude-opus-4-8",
      thinkingMode: "default" as const,
      withThinking: false,
      supportsTemperature: false,
      expectedTemperature: false
    },
    {
      model: "claude-opus-4-6",
      thinkingMode: "default" as const,
      withThinking: false,
      supportsTemperature: true,
      expectedTemperature: true
    }
  ]) {
    const model = {
      ...modelFor("anthropic", "anthropic-messages"),
      ...(fixture.supportsTemperature
        ? {}
        : { compat: { supportsTemperature: false } })
    } as Model<"anthropic-messages">;
    let payload: Record<string, unknown> | undefined;
    const models = fakeModels(
      model,
      () => successfulStream(model, fixture.withThinking),
      undefined,
      (value) => { payload = value; }
    );
    const legacy = subscriptionSettings(
      "anthropic-subscription-messages",
      "anthropic",
      "anthropic-messages",
      credentials,
      models
    );
    const runtime = providerRuntimeFor(legacy);
    const settings = attachProviderRuntime(
      { ...legacy, model: fixture.model, temperature: 0.4 },
      { ...runtime, effort: "default", thinkingMode: fixture.thinkingMode }
    );

    assert.equal(
      await collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
      "answer",
      fixture.model
    );
    assert.equal(
      "temperature" in (payload ?? {}),
      fixture.expectedTemperature,
      fixture.model
    );
    assert.equal(payload?.temperature, fixture.expectedTemperature ? 0.4 : undefined);
    assert.equal(settings.temperature, 0.4, fixture.model);
  }
});

test("subscription Anthropic lowering emits adaptive display without a budget", async (t) => {
  const directory = await temporaryDirectory(t, "1667-reasoning-subscription-anthropic-");
  const credentials = createSubscriptionCredentialStore(directory);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  let seen: Record<string, unknown> | undefined;
  const models = fakeModels(model, (_context, options) => {
    seen = options;
    return successfulStream(model, true);
  });
  const legacy = subscriptionSettings(
    "anthropic-subscription-messages", "anthropic", "anthropic-messages",
    credentials, models
  );
  const runtime = providerRuntimeFor(legacy);
  const settings = attachProviderRuntime(
    { ...legacy, model: "claude-opus-5", temperature: null },
    { ...runtime, effort: "high", thinkingMode: "on" }
  );
  await collect(streamCompletion(settings, PROMPT, new AbortController().signal));
  assert.equal(seen?.thinkingEnabled, true);
  assert.equal(seen?.effort, "high");
  assert.equal(seen?.thinkingDisplay, "summarized");
  assert.equal(seen?.thinkingBudgetTokens, undefined);
});

test("subscription Anthropic refuses effort when default thinking is omitted", async (t) => {
  const directory = await temporaryDirectory(t, "1667-reasoning-subscription-anthropic-omitted-");
  const credentials = createSubscriptionCredentialStore(directory);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  let streamCalls = 0;
  const models = fakeModels(model, () => {
    streamCalls += 1;
    return successfulStream(model, false);
  });
  const legacy = subscriptionSettings(
    "anthropic-subscription-messages", "anthropic", "anthropic-messages",
    credentials, models
  );
  const runtime = providerRuntimeFor(legacy);
  const settings = attachProviderRuntime(
    { ...legacy, model: "claude-opus-4-8", temperature: null },
    { ...runtime, effort: "high", thinkingMode: "default" }
  );
  await assert.rejects(
    collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
    (error: unknown) => error instanceof ProviderError
      && /cannot serialize effort unless thinking is enabled/.test(error.message)
  );
  assert.equal(streamCalls, 0);
});

test("subscription Anthropic refuses effort when thinking is disabled", async (t) => {
  const directory = await temporaryDirectory(t, "1667-reasoning-subscription-anthropic-disabled-");
  const credentials = createSubscriptionCredentialStore(directory);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  let streamCalls = 0;
  const models = fakeModels(model, () => {
    streamCalls += 1;
    return successfulStream(model, false);
  });
  const legacy = subscriptionSettings(
    "anthropic-subscription-messages", "anthropic", "anthropic-messages",
    credentials, models
  );
  const runtime = providerRuntimeFor(legacy);
  const settings = attachProviderRuntime(
    { ...legacy, model: "claude-opus-5", temperature: null },
    { ...runtime, effort: "high", thinkingMode: "off" }
  );
  await assert.rejects(
    collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
    (error: unknown) => error instanceof ProviderError
      && /cannot serialize effort unless thinking is enabled/.test(error.message)
  );
  assert.equal(streamCalls, 0);
});

test("subscription Anthropic truncated models refuse temperature with top p when thinking is not on", async (t) => {
  const directory = await temporaryDirectory(t, "1667-reasoning-subscription-anthropic-sampling-");
  const credentials = createSubscriptionCredentialStore(directory);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  let streamCalls = 0;
  const models = fakeModels(model, () => {
    streamCalls += 1;
    return successfulStream(model, false);
  });
  const legacy = subscriptionSettings(
    "anthropic-subscription-messages", "anthropic", "anthropic-messages",
    credentials, models
  );
  const runtime = providerRuntimeFor(legacy);
  const settings = attachProviderRuntime(
    { ...legacy, model: "claude-sonnet-4-6", temperature: 0.4 },
    {
      ...runtime,
      effort: "default",
      thinkingMode: "default",
      sampling: { ...runtime.sampling, topP: 0.97 }
    }
  );
  await assert.rejects(
    collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
    (error: unknown) => error instanceof ProviderError
      && /cannot combine temperature with top p/.test(error.message)
  );
  assert.equal(streamCalls, 0);
});

test("subscription policy refuses sampling that pinned Pi cannot serialize", async (t) => {
  const directory = await temporaryDirectory(t, "1667-reasoning-subscription-sampling-");
  const credentials = createSubscriptionCredentialStore(directory);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  const model = modelFor("openai-codex", "openai-codex-responses");
  let streamCalls = 0;
  const models = fakeModels(model, () => {
    streamCalls += 1;
    return successfulStream(model, false);
  });
  const legacy = subscriptionSettings(
    "openai-codex-responses", "openai-compatible", "openai-codex-responses",
    credentials, models
  );
  const runtime = providerRuntimeFor(legacy);
  const reasoning = { effort: "default" as const, thinkingMode: "default" as const };
  const settings = attachProviderRuntime(
    { ...legacy, model: "gpt-5.6-sol" },
    { ...runtime, ...reasoning, sampling: { ...runtime.sampling, topP: 0.9 } }
  );
  await assert.rejects(
    collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
    (error: unknown) => error instanceof ProviderError
      && /pinned subscription adapter cannot serialize sampling controls/.test(error.message)
  );
  assert.equal(streamCalls, 0);
});
