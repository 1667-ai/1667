import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ProviderError } from "../server/errors.js";
import { streamCompletion, type StreamOutcome } from "../server/providers.js";
import {
  attachProviderRuntime,
  providerRuntimeFor
} from "../server/provider-runtime.js";
import { createSubscriptionCredentialStore } from "../server/subscription-credential-store.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import {
  ACCESS,
  PROMPT,
  assistant,
  collect,
  deferredResultFailureStream,
  event,
  eventStream,
  fakeModels,
  modelFor,
  oauth,
  subscriptionSettings,
  successfulStream,
  temporaryDirectory
} from "./subscription-adapter-test-helpers.js";

test("pinned subscription adapters refuse token probabilities before Pi dispatch", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-token-probabilities-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  await credentials.modify("anthropic", async () => oauth(ACCESS));

  for (const [protocol, provider, api, providerId] of [
    ["openai-codex-responses", "openai-compatible", "openai-codex-responses", "openai-codex"],
    ["anthropic-subscription-messages", "anthropic", "anthropic-messages", "anthropic"]
  ] as const) {
    const model = modelFor(providerId, api);
    let streamCalls = 0;
    const settings = subscriptionSettings(
      protocol,
      provider,
      api,
      credentials,
      fakeModels(model, () => {
        streamCalls += 1;
        return successfulStream(model, false);
      })
    );
    const runtime = providerRuntimeFor(settings);
    const tokenProbabilitySettings = attachProviderRuntime(
      settings,
      { ...runtime, tokenProbabilities: 5 },
      true
    );

    await assert.rejects(
      collect(streamCompletion(tokenProbabilitySettings, PROMPT, new AbortController().signal)),
      (error: unknown) => error instanceof ProviderError
        && error.message === "Token probabilities are unavailable because the pinned subscription adapter cannot serialize token probabilities."
    );
    assert.equal(streamCalls, 0);
  }
});

test("Pi terminal timing survives slow consumers after buffered deltas", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-slow-consumer-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  const textDeltas = Array.from({ length: 64 }, () => "a");
  const settings = subscriptionSettings(
    "anthropic-subscription-messages",
    "anthropic",
    "anthropic-messages",
    credentials,
    fakeModels(model, () => successfulStream(model, true, textDeltas)),
    { responseHeaderMs: 1_000, idleMs: 15, totalMs: 75 }
  );
  const reasoning: string[] = [];
  const output: string[] = [];
  for await (const chunk of streamCompletion(settings, PROMPT, new AbortController().signal, {
    onReasoning: async (delta) => {
      reasoning.push(delta.text);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })) {
    output.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(reasoning, ["thinking"]);
  assert.equal(output.join(""), textDeltas.join(""));
});

test("subscription cleanup aborts Pi on failure and consumer return", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-cleanup-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  const model = modelFor("openai-codex", "openai-codex-responses");
  let failedAbort = false;
  const failedModels = fakeModels(model, (_context, options) => {
    (options.signal as AbortSignal).addEventListener("abort", () => { failedAbort = true; });
    return eventStream(model, [
      event("start", model),
      event("text_start", model),
      event("text_delta", model, "partial"),
      event("toolcall_start", model)
    ], true);
  });
  const failedSettings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    failedModels
  );
  const chunks: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const chunk of streamCompletion(failedSettings, PROMPT, new AbortController().signal)) {
        chunks.push(chunk);
      }
    })(),
    /cannot return tool calls/
  );
  assert.deepEqual(chunks, ["partial"]);
  assert.equal(failedAbort, true);

  let earlyAbort = false;
  const earlyModels = fakeModels(model, (_context, options) => {
    const stream = createAssistantMessageEventStream();
    (options.signal as AbortSignal).addEventListener("abort", () => {
      earlyAbort = true;
      stream.end();
    }, { once: true });
    stream.push(event("start", model));
    stream.push(event("text_start", model));
    stream.push(event("text_delta", model, "x".repeat(64)));
    return stream;
  });
  const earlySettings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    earlyModels
  );
  const iterator = streamCompletion(earlySettings, PROMPT, new AbortController().signal)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.ok(first.value.length > 0);
  await iterator.return(undefined);
  assert.equal(earlyAbort, true);
});

test("subscription pump rejects large tool events before queueing them", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-tool-buffer-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  for (const toolEvent of [
    {
      type: "toolcall_delta" as const,
      contentIndex: 0,
      delta: "x".repeat(4 * 1024 * 1024),
      partial: assistant(model)
    },
    {
      type: "toolcall_end" as const,
      contentIndex: 0,
      toolCall: {
        type: "toolCall" as const,
        id: "tool-1",
        name: "fixture",
        arguments: { payload: "x".repeat(4 * 1024 * 1024) }
      },
      partial: assistant(model)
    }
  ]) {
    let advancedAfterTool = false;
    let enteredReasoning!: () => void;
    const reasoningEntered = new Promise<void>((resolve) => { enteredReasoning = resolve; });
    let releaseReasoning!: () => void;
    const reasoningBlocked = new Promise<void>((resolve) => { releaseReasoning = resolve; });
    const settings = subscriptionSettings(
      "anthropic-subscription-messages",
      "anthropic",
      "anthropic-messages",
      credentials,
      fakeModels(model, () => ({
        async *[Symbol.asyncIterator]() {
          yield event("start", model);
          yield event("thinking_start", model);
          yield event("thinking_delta", model, "thinking");
          yield toolEvent;
          advancedAfterTool = true;
          yield event("done", model);
        },
        async result() {
          return assistant(model);
        }
      }))
    );
    const pending = collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
      onReasoning: async () => {
        enteredReasoning();
        await reasoningBlocked;
      }
    }));
    await reasoningEntered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(advancedAfterTool, false);
    releaseReasoning();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ProviderError
        && error.message === "Subscription providers cannot return tool calls."
    );
  }
});

test("subscription pump aborts Pi immediately when its bounded buffer cannot retain an event", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-buffer-limit-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  for (const mode of ["oversized", "saturated"] as const) {
    let advancedAfterFailure = false;
    let transportAborted = false;
    let enteredReasoning!: () => void;
    const reasoningEntered = new Promise<void>((resolve) => { enteredReasoning = resolve; });
    let releaseReasoning!: () => void;
    const reasoningBlocked = new Promise<void>((resolve) => { releaseReasoning = resolve; });
    const settings = subscriptionSettings(
      "anthropic-subscription-messages",
      "anthropic",
      "anthropic-messages",
      credentials,
      fakeModels(model, (_context, options) => {
        (options.signal as AbortSignal).addEventListener("abort", () => {
          transportAborted = true;
        }, { once: true });
        return {
          async *[Symbol.asyncIterator]() {
            yield event("start", model);
            yield event("thinking_start", model);
            yield event("thinking_delta", model, "thinking");
            if (mode === "oversized") {
              yield {
                type: "text_delta" as const,
                contentIndex: 0,
                delta: "x".repeat(2 * 1024 * 1024),
                partial: assistant(model)
              };
            } else {
              for (let index = 0; index < 40; index += 1) {
                yield {
                  type: "thinking_delta" as const,
                  contentIndex: index + 1,
                  delta: "x".repeat(64 * 1024),
                  partial: assistant(model)
                };
              }
            }
            advancedAfterFailure = true;
            yield event("done", model);
          },
          async result() {
            return assistant(model);
          }
        };
      })
    );
    const pending = collect(streamCompletion(settings, PROMPT, new AbortController().signal, {
      onReasoning: async () => {
        enteredReasoning();
        await reasoningBlocked;
      }
    }));
    await reasoningEntered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transportAborted, true);
    assert.equal(advancedAfterFailure, false);
    releaseReasoning();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof ProviderError
        && (
          error.message === "Subscription provider event exceeded the bounded buffer."
          || error.message === "Subscription provider event buffer is full."
        )
    );
  }
});

test("subscription adapter rejects tool events and deferred result failures", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-errors-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("openai-codex", async () => oauth(ACCESS));
  const model = modelFor("openai-codex", "openai-codex-responses");
  const settings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    fakeModels(model, () => eventStream(model, [
      event("start", model),
      event("toolcall_start", model)
    ], true))
  );
  const outcome: StreamOutcome = { finishReason: null, providerTerminal: false };
  await assert.rejects(
    collect(streamCompletion(settings, PROMPT, new AbortController().signal, { outcome })),
    (error: unknown) => error instanceof ProviderError
      && error.message === "Subscription providers cannot return tool calls."
  );
  assert.equal(outcome.providerTerminal, false);

  const mismatchModel = modelFor("anthropic", "anthropic-messages");
  const mismatchSettings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "anthropic-messages",
    credentials,
    fakeModels(mismatchModel, () => successfulStream(mismatchModel, false))
  );
  await assert.rejects(
    collect(streamCompletion(mismatchSettings, PROMPT, new AbortController().signal)),
    /protocol and Pi model API do not match/
  );

  const imagePrompt = {
    operation: "continue",
    turns: [{
      role: "user",
      blocks: [{
        stability: "volatile",
        kind: "image",
        image: {},
        boundaryAfter: "none"
      }]
    }]
  } as unknown as PromptPlan;
  await assert.rejects(
    collect(streamCompletion(settings, imagePrompt, new AbortController().signal)),
    (error: unknown) => error instanceof ProviderError
      && error.message === "Subscription providers do not support image prompts."
  );

  const resultErrorModels = fakeModels(model, () => deferredResultFailureStream(model));
  const resultErrorSettings = subscriptionSettings(
    "openai-codex-responses",
    "openai-compatible",
    "openai-codex-responses",
    credentials,
    resultErrorModels
  );
  await assert.rejects(
    collect(streamCompletion(resultErrorSettings, PROMPT, new AbortController().signal)),
    (error: unknown) => error instanceof ProviderError
      && error.message.includes("deferred-result-failure")
      && !error.message.includes(ACCESS)
  );
});

test("subscription response-header, total, and idle deadlines use Pi boundaries", async (t) => {
  const secretsDir = await temporaryDirectory(t, "1667-subscription-timeouts-");
  const credentials = createSubscriptionCredentialStore(secretsDir);
  await credentials.modify("anthropic", async () => oauth(ACCESS));
  const model = modelFor("anthropic", "anthropic-messages");
  const delayed = (mode: "header" | "total" | "idle") => {
    const stream = createAssistantMessageEventStream();
    const signalAware = (options: Record<string, unknown>) => {
      const requestSignal = options.signal as AbortSignal;
      requestSignal.addEventListener("abort", () => stream.end(), { once: true });
    };
    if (mode === "total") {
      stream.push(event("start", model));
    }
    if (mode === "idle") {
      stream.push(event("start", model));
      stream.push(event("text_start", model));
      stream.push(event("text_delta", model, "partial"));
    }
    return { stream, signalAware };
  };
  for (const mode of ["header", "total", "idle"] as const) {
    const fake = fakeModels(model, (_context, options) => {
      const item = delayed(mode);
      item.signalAware(options);
      return item.stream;
    });
    const settings = subscriptionSettings(
      "anthropic-subscription-messages",
      "anthropic",
      "anthropic-messages",
      credentials,
      fake,
      {
        responseHeaderMs: mode === "header" ? 10 : 1_000,
        firstTokenMs: 10,
        idleMs: mode === "idle" ? 10 : 1_000,
        totalMs: mode === "total" ? 200 : 1_000
      }
    );
    await assert.rejects(
      collect(streamCompletion(settings, PROMPT, new AbortController().signal)),
      (error: unknown) => error instanceof ProviderError
        && error.timeout === (
          mode === "header"
            ? "provider-response-header"
            : mode === "total"
              ? "provider-total"
              : "provider-idle"
        )
    );
  }
});
