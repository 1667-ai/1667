import assert from "node:assert/strict";
import test from "node:test";
import { countPromptTokens } from "../server/tokenize-probe.js";
import {
  attachProviderRuntime,
  type ProviderRuntime
} from "../server/provider-runtime.js";
import type { ChatMessage } from "../shared/prompt-plan.js";
import {
  EMPTY_SAMPLING_V2,
  type SettingsPresetV2,
  type SettingsProtocolV2,
  type SubscriptionProtocolV2,
  type TextPromptFormatV2
} from "../shared/settings-v2-types.js";
import { MAX_COUNTED_PROMPT_CHARS } from "../shared/tokenize-source.js";
import type { GenerationSettings, Provider } from "../shared/types.js";

test("an OpenAI official preset returns an exact count with a per-message split", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the bundled tokenizer must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [
    { role: "system", content: "Write closely." },
    { role: "user", content: "Continue the story about the lantern." }
  ];
  const result = await countPromptTokens(
    settings({ preset: "openai", baseUrl: "https://api.openai.com", model: "gpt-5" }),
    messages
  );

  assert.equal(result.kind, "counted");
  if (result.kind !== "counted") return;
  assert.equal(result.source, "bundled-openai");
  assert.equal(result.grade, "exact");
  // OpenAI's documented chat framing: three fixed tokens and one role token
  // for each message, then three more to prime the reply. "Write closely."
  // is three o200k tokens and the instruction is seven.
  assert.deepEqual(result.perMessage, [3 + 4, 7 + 4]);
  assert.equal(result.total, 3 + 4 + 7 + 4 + 3);
});

test("OpenAI text completions count the exact raw and ChatML wire prompts", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the bundled tokenizer must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [
    { role: "system", content: "Write closely." },
    { role: "user", content: "Continue the story about the lantern." }
  ];
  for (const [textPromptFormat, total] of [
    ["raw", 10],
    ["chatml", 44]
  ] as const) {
    const result = await countPromptTokens(settings({
      preset: "openai",
      provider: "text-completion",
      protocol: "text-completions",
      textPromptFormat,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5"
    }), messages);
    assert.deepEqual(result, {
      kind: "counted",
      source: "bundled-openai",
      grade: "exact",
      total,
      perMessage: null
    });
  }
});

test("an OpenAI model on the older encoding is counted with that encoding", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the bundled tokenizer must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // Not every official model is o200k: gpt-4, gpt-4-turbo and gpt-3.5-turbo
  // are cl100k. This sentence costs 8 tokens under o200k and 15 under cl100k,
  // so counting it with the wrong encoding would be nearly twice out — and it
  // would carry no mark to say the number was approximate.
  const messages: ChatMessage[] = [
    { role: "user", content: "こんにちは世界、今日はいい天気ですね" }
  ];
  const official = { preset: "openai", baseUrl: "https://api.openai.com" } as const;

  const modern = await countPromptTokens(settings({ ...official, model: "gpt-5" }), messages);
  const older = await countPromptTokens(settings({ ...official, model: "gpt-4" }), messages);

  assert.equal(modern.kind, "counted");
  assert.equal(older.kind, "counted");
  if (modern.kind !== "counted" || older.kind !== "counted") return;
  assert.equal(modern.total, 8 + 4 + 3);
  assert.equal(older.total, 15 + 4 + 3);
});

test("an OpenAI model this build cannot tokenize keeps the estimate", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("an untokenizable model must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // An unreleased model or a fine-tune. Guessing an encoding here would print
  // a wrong number with no mark on it, so the meter keeps its estimate.
  const result = await countPromptTokens(
    settings({
      preset: "openai",
      baseUrl: "https://api.openai.com",
      model: "ft:gpt-4o:acme::a1b2c3"
    }),
    [{ role: "user", content: "Continue the story about the lantern." }]
  );

  assert.deepEqual(result, { kind: "estimate", reason: "no-source" });
});

test("prose that spells a special token is counted as prose", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the bundled tokenizer must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  // A story about a model, or a transcript pasted into one, can hold this
  // spelling verbatim. Refusing it would report no tokenize source for the
  // route and leave the rest of the session estimated.
  const result = await countPromptTokens(
    settings({ preset: "openai", baseUrl: "https://api.openai.com", model: "gpt-5" }),
    [{ role: "user", content: "The screen showed <|endoftext|> and went dark." }]
  );

  assert.equal(result.kind, "counted");
  if (result.kind !== "counted") return;
  assert.equal(result.grade, "exact");
  assert.equal(result.total, 14 + 4 + 3);
});

test("an Anthropic official preset returns the endpoint's exact total, no split, and lifts system into system", async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedBody: unknown;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://api.anthropic.com/v1/messages/count_tokens");
    assert.equal(input.headers.get("anthropic-version"), "2023-06-01");
    capturedBody = JSON.parse(await input.text());
    return Response.json({ input_tokens: 42 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [
    { role: "system", content: "Write closely." },
    { role: "system", content: "Keep it short." },
    { role: "user", content: "Continue the story." }
  ];
  const result = await countPromptTokens(
    settings({ preset: "anthropic", provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-fixture" }),
    messages
  );

  assert.deepEqual(result, {
    kind: "counted",
    source: "anthropic-count-tokens",
    grade: "exact",
    total: 42,
    perMessage: null
  });
  assert.deepEqual(capturedBody, {
    model: "claude-fixture",
    messages: [{ role: "user", content: "Continue the story." }],
    system: "Write closely.\n\nKeep it short."
  });
});

test("a llama.cpp preset returns the near-exact templated-prompt count", async (t) => {
  const messages: ChatMessage[] = [{ role: "user", content: "Continue." }];
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    calls.push(input.url);
    if (input.url === "https://models.example/apply-template") {
      const body = JSON.parse(await input.text()) as { messages: unknown; model: unknown };
      assert.deepEqual(body.messages, messages);
      // A multi-model server picks from the body, so both calls have to name
      // the model that will serve the request.
      assert.equal(body.model, "fixture");
      return Response.json({ prompt: "<s>rendered prompt</s>" });
    }
    assert.equal(input.url, "https://models.example/tokenize");
    const body = JSON.parse(await input.text()) as {
      content: unknown; add_special: unknown; model: unknown;
    };
    assert.equal(body.content, "<s>rendered prompt</s>");
    assert.equal(body.add_special, true);
    assert.equal(body.model, "fixture");
    return Response.json({ tokens: [1, 2, 3, 4, 5] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await countPromptTokens(
    settings({ preset: "llama-cpp", baseUrl: "https://models.example/v1", model: "fixture" }),
    messages
  );

  assert.deepEqual(result, {
    kind: "counted",
    source: "llama-cpp-tokenize",
    grade: "near-exact",
    total: 5,
    perMessage: null
  });
  assert.deepEqual(calls, [
    "https://models.example/apply-template",
    "https://models.example/tokenize"
  ]);
});

test("a llama.cpp reply that is not token identifiers is not counted", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    if (input.url.endsWith("/apply-template")) return Response.json({ prompt: "rendered" });
    // An error payload, not identifiers. Counting its length would report a
    // whole story as a near-exact single token.
    return Response.json({ tokens: ["context length exceeded"] });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await countPromptTokens(
    settings({ preset: "llama-cpp", baseUrl: "https://models.example/v1", model: "fixture" }),
    [{ role: "user", content: "A whole story's worth of prose." }]
  );

  assert.deepEqual(result, { kind: "estimate", reason: "probe-failed" });
});

test("the superseded OpenAI snapshot is counted with its own message framing", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("the bundled tokenizer must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [{ role: "user", content: "Continue the story about the lantern." }];
  const official = { preset: "openai", baseUrl: "https://api.openai.com" } as const;

  const current = await countPromptTokens(settings({ ...official, model: "gpt-4" }), messages);
  const legacy = await countPromptTokens(
    settings({ ...official, model: "gpt-3.5-turbo-0301" }),
    messages
  );

  // Same encoding, one more token of framing for each message.
  assert.equal(current.kind === "counted" ? current.total : null, 7 + 4 + 3);
  assert.equal(legacy.kind === "counted" ? legacy.total : null, 7 + 5 + 3);
});

test("a KoboldCpp preset returns the near-exact tokencount", async (t) => {
  const messages: ChatMessage[] = [{ role: "user", content: "Continue." }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.ok(input instanceof Request);
    assert.equal(input.url, "https://models.example/api/extra/tokencount");
    const body = JSON.parse(await input.text()) as { messages: unknown };
    assert.deepEqual(body.messages, messages);
    return Response.json({ value: 77, ids: [1, 2], prompt: "rendered" });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await countPromptTokens(
    settings({ preset: "koboldcpp", baseUrl: "https://models.example/v1", model: "fixture" }),
    messages
  );

  assert.deepEqual(result, {
    kind: "counted",
    source: "koboldcpp-tokencount",
    grade: "near-exact",
    total: 77,
    perMessage: null
  });
});

test("Ollama, LM Studio, OpenRouter, and custom presets keep the estimate and never reach the network", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("a source-less preset must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [{ role: "user", content: "Continue." }];
  for (const preset of ["ollama", "lm-studio", "openrouter", "custom"] as const) {
    const result = await countPromptTokens(settings({ preset }), messages);
    assert.deepEqual(result, { kind: "estimate", reason: "no-source" });
  }
});

test("a probe that throws returns the probe-failed estimate instead of raising", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("simulated connection failure");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [{ role: "user", content: "Probe failure fixture: throw." }];
  const result = await countPromptTokens(
    settings({ preset: "koboldcpp", baseUrl: "https://throws.example/v1" }),
    messages
  );

  assert.deepEqual(result, { kind: "estimate", reason: "probe-failed" });
});

test("a probe answering with an unreadable shape returns the probe-failed estimate", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ unexpected: "shape" })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [{ role: "user", content: "Probe failure fixture: bad shape." }];
  const result = await countPromptTokens(
    settings({
      preset: "anthropic",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-bad-shape"
    }),
    messages
  );

  assert.deepEqual(result, { kind: "estimate", reason: "probe-failed" });
});

test("a probe that exceeds its deadline returns the probe-failed estimate", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    return await new Promise<Response>((_resolve, reject) => {
      // The deadline here is ten milliseconds, so on a loaded machine it can
      // already have passed by the time this runs. An `abort` listener added
      // to a signal that has aborted never fires, and the request would then
      // hang for the whole run rather than fail.
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [{ role: "user", content: "Probe failure fixture: timeout." }];
  const result = await countPromptTokens(
    settings({
      preset: "koboldcpp",
      baseUrl: "https://times-out.example/v1",
      timeouts: { responseHeaderMs: 10, firstTokenMs: 10, idleMs: 10, totalMs: 20 }
    }),
    messages
  );

  assert.deepEqual(result, { kind: "estimate", reason: "probe-failed" });
});

test("caller cancellation propagates instead of degrading to an estimate", async (t) => {
  const originalFetch = globalThis.fetch;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  globalThis.fetch = (async (input, init) => {
    assert.ok(input instanceof Request);
    const signal = init?.signal ?? input.signal;
    markStarted();
    return await new Promise<Response>((_resolve, reject) => {
      // Same reason as the deadline fixture above: a signal that has already
      // aborted never delivers the event.
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const controller = new AbortController();
  const messages: ChatMessage[] = [{ role: "user", content: "Caller-cancelled probe fixture." }];
  const pending = countPromptTokens(
    settings({ preset: "koboldcpp", baseUrl: "https://cancels.example/v1" }),
    messages,
    controller.signal
  );
  await started;
  controller.abort(new Error("caller canceled the token probe"));

  await assert.rejects(pending, /caller canceled the token probe/);
});

test("a message array past the counted-character ceiling keeps the estimate and skips the network", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("an oversized prompt must not reach the network");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const messages: ChatMessage[] = [
    { role: "user", content: "x".repeat(MAX_COUNTED_PROMPT_CHARS + 1) }
  ];
  const result = await countPromptTokens(
    settings({
      preset: "anthropic",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-oversized"
    }),
    messages
  );

  assert.deepEqual(result, { kind: "estimate", reason: "too-large" });
});

test("an identical repeated count reuses the cache; changed messages probe again", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let nextValue = 10;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ value: nextValue, ids: [], prompt: "compiled prompt" });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const base = settings({ preset: "koboldcpp", baseUrl: "https://cache-fixture.example/v1" });
  const messages: ChatMessage[] = [{ role: "user", content: "Cache me once." }];

  const first = await countPromptTokens(base, messages);
  const second = await countPromptTokens(base, messages);
  assert.equal(calls, 1, "an identical repeated request must not re-probe");
  assert.deepEqual(first, second);

  nextValue = 20;
  const changed = await countPromptTokens(base, [
    { role: "user", content: "Cache me differently." }
  ]);
  assert.equal(calls, 2, "changed messages must probe again");
  assert.equal(changed.kind === "counted" ? changed.total : null, 20);
});

test("a cached model-server count stops being reused once it is old", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let nextValue = 10;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ value: nextValue, ids: [], prompt: "compiled prompt" });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const base = settings({ preset: "koboldcpp", baseUrl: "https://ageing-fixture.example/v1" });
  const messages: ChatMessage[] = [{ role: "user", content: "The same prose as before." }];
  let clock = 1_000;
  const now = () => clock;

  const first = await countPromptTokens(base, messages, undefined, now);
  assert.equal(first.kind === "counted" ? first.total : null, 10);
  clock += 5_000;
  await countPromptTokens(base, messages, undefined, now);
  assert.equal(calls, 1, "a fresh entry still answers without a probe");

  // The same address can be serving a different model by now: a local server
  // reloads, and nothing 1667 keys on has to change with it.
  clock += 60_000;
  nextValue = 4_242;
  const aged = await countPromptTokens(base, messages, undefined, now);

  assert.equal(calls, 2, "an aged entry must probe the server again");
  assert.equal(aged.kind === "counted" ? aged.total : null, 4_242);
});

test("a KoboldCpp reply that ignored the messages is not counted", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => (
    // A release old enough to read only `prompt`: it tokenized an empty
    // string, so the count is its beginning-of-sequence token and the compiled
    // prompt comes back empty.
    Response.json({ value: 1, ids: [1], prompt: "" })
  )) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await countPromptTokens(
    settings({ preset: "koboldcpp", baseUrl: "https://legacy-fixture.example/v1" }),
    [{ role: "user", content: "A whole story's worth of prose." }]
  );

  assert.deepEqual(result, { kind: "estimate", reason: "probe-failed" });
});

function settings(options: {
  readonly preset: SettingsPresetV2;
  readonly provider?: Provider;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeouts?: ProviderRuntime["timeouts"];
  readonly protocol?: Exclude<SettingsProtocolV2, SubscriptionProtocolV2>;
  readonly textPromptFormat?: TextPromptFormatV2;
}): GenerationSettings {
  const value: GenerationSettings = {
    provider: options.provider ?? "openai-compatible",
    baseUrl: options.baseUrl ?? "https://models.example/v1",
    model: options.model ?? "fixture",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };
  const runtime: ProviderRuntime = {
    preset: options.preset,
    auth: { type: "none" },
    headers: [],
    timeouts: options.timeouts ?? {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities: null,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    },
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    ...(options.textPromptFormat === undefined
      ? {}
      : { textPromptFormat: options.textPromptFormat })
  };
  return attachProviderRuntime(value, runtime, true);
}
