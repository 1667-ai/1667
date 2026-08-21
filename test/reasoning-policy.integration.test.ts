import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnthropicMessagesRequestBody,
  buildOpenAiChatRequestBody
} from "../server/provider-request-body.js";
import {
  attachProviderRuntime,
  providerRuntimeFromV2,
  type StandardModelConnectionV2
} from "../server/provider-runtime.js";
import type { PromptCacheWirePlan } from "../server/provider-cache-policy.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import {
  EMPTY_SAMPLING_V2,
  type ModelCapabilitiesV2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import {
  ANTHROPIC_REASONING_CAPABILITIES,
  OPENAI_REASONING_CAPABILITIES,
  SUBSCRIPTION_REASONING_CAPABILITIES
} from "../shared/reasoning-capabilities.js";
import {
  ANTHROPIC_SAMPLING_RULES,
  OPENAI_SAMPLING_RULES,
  resolveReasoningSampling
} from "../shared/sampling-capabilities.js";
import type { GenerationSettings } from "../shared/types.js";

const OMIT_CACHE: Extract<PromptCacheWirePlan, { kind: "omit" }> = {
  kind: "omit",
  reason: "policy-off"
};
const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [{
    role: "user",
    blocks: [{ stability: "volatile", kind: "request", text: "Continue.", boundaryAfter: "none" }]
  }]
};

const CAPABILITIES: ModelCapabilitiesV2 = {
  temperature: "supported",
  assistantPrefill: "unknown",
  reasoningEffort: "unknown",
  promptCaching: "unknown"
};

test("OpenAI exact policy lowers off to none and preserves provider default temperature", async () => {
  const settings = route("openai-compatible", "openai", "https://api.openai.com/v1", "gpt-5.4", "default", "off");
  const body = await buildOpenAiChatRequestBody(settings, PROMPT, OMIT_CACHE);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.temperature, 0.4);
});

test("OpenAI exact policy rejects off with explicit effort", async () => {
  const settings = route("openai-compatible", "openai", "https://api.openai.com/v1", "gpt-5.4", "medium", "off");
  await assert.rejects(
    buildOpenAiChatRequestBody(settings, PROMPT, OMIT_CACHE),
    /Thinking Mode off cannot be combined with an explicit OpenAI effort/
  );
});

test("persisted unsupported vetoes OpenAI controls without blocking a default request", async () => {
  const settings = route(
    "openai-compatible",
    "openai",
    "https://api.openai.com/v1",
    "gpt-5.4",
    "default",
    "default",
    null,
    EMPTY_SAMPLING_V2,
    "unsupported"
  );
  const body = await buildOpenAiChatRequestBody(settings, PROMPT, OMIT_CACHE);
  assert.equal("reasoning_effort" in body, false);

  await assert.rejects(
    buildOpenAiChatRequestBody(
      route(
        "openai-compatible",
        "openai",
        "https://api.openai.com/v1",
        "gpt-5.4",
        "high",
        "default",
        null,
        EMPTY_SAMPLING_V2,
        "unsupported"
      ),
      PROMPT,
      OMIT_CACHE
    ),
    /explicitly disables reasoning controls/u
  );
});

test("persisted unsupported o-series never rows keep no reasoning wire but refuse sampling", async () => {
  const unsupported = (sampling: SamplingSettingsV2, tokenProbabilities: number | null = null) =>
    route(
      "openai-compatible",
      "openai",
      "https://api.openai.com/v1",
      "o3",
      "default",
      "default",
      null,
      sampling,
      "unsupported",
      tokenProbabilities
    );
  const body = await buildOpenAiChatRequestBody(
    unsupported(EMPTY_SAMPLING_V2),
    PROMPT,
    OMIT_CACHE
  );
  assert.equal("reasoning_effort" in body, false);

  const cases = [
    ["top p", { ...EMPTY_SAMPLING_V2, topP: 0.9 }],
    ["frequency penalty", { ...EMPTY_SAMPLING_V2, frequencyPenalty: 0.2 }],
    ["presence penalty", { ...EMPTY_SAMPLING_V2, presencePenalty: 0.2 }],
    ["seed", { ...EMPTY_SAMPLING_V2, seed: 42 }],
    ["stop", { ...EMPTY_SAMPLING_V2, stop: ["END"] }],
    ["logit bias", { ...EMPTY_SAMPLING_V2, logitBias: { "15043": 1 } }],
    ["phrase bias", { ...EMPTY_SAMPLING_V2, phraseBias: [{ phrase: "ember", weight: 1 }] }],
    ["banned strings", { ...EMPTY_SAMPLING_V2, bannedStrings: ["ember"] }]
  ] as const;
  for (const [label, sampling] of cases) {
    await assert.rejects(
      buildOpenAiChatRequestBody(unsupported(sampling), PROMPT, OMIT_CACHE),
      /does not accept sampling controls/u,
      label
    );
  }
  await assert.rejects(
    buildOpenAiChatRequestBody(unsupported(EMPTY_SAMPLING_V2, 3), PROMPT, OMIT_CACHE),
    /does not accept sampling controls/u
  );
});

test("unknown OpenAI model with persisted unsupported reasoning keeps default sampling", async () => {
  const body = await buildOpenAiChatRequestBody(
    route(
      "openai-compatible",
      "openai",
      "https://api.openai.com/v1",
      "gpt-4o",
      "default",
      "default",
      0.4,
      { ...EMPTY_SAMPLING_V2, topP: 0.9 },
      "unsupported"
    ),
    PROMPT,
    OMIT_CACHE
  );
  assert.equal(body.temperature, 0.4);
  assert.equal(body.top_p, 0.9);
  assert.equal("reasoning_effort" in body, false);

  await assert.rejects(
    buildOpenAiChatRequestBody(
      route(
        "openai-compatible",
        "openai",
        "https://api.openai.com/v1",
        "gpt-4o",
        "high",
        "default",
        null,
        EMPTY_SAMPLING_V2,
        "unsupported"
      ),
      PROMPT,
      OMIT_CACHE
    ),
    /explicitly disables reasoning controls/u
  );
});

test("OpenAI models with normal sampling keep temperature while reasoning", async () => {
  const settings = route(
    "openai-compatible",
    "openai",
    "https://api.openai.com/v1",
    "gpt-5.6",
    "default",
    "default"
  );
  const body = await buildOpenAiChatRequestBody(settings, PROMPT, OMIT_CACHE);
  assert.equal(body.temperature, 0.4);
});

test("OpenAI Pro models refuse direct streaming Chat Completions reasoning", async () => {
  const cases = [
    ["default", "default", "unknown"],
    ["high", "default", "unknown"],
    ["default", "default", "unsupported"]
  ] as const;
  for (const model of ["gpt-5.5-pro", "gpt-5.4-pro"] as const) {
    for (const [effort, thinkingMode, reasoningEffort] of cases) {
      await assert.rejects(
        buildOpenAiChatRequestBody(
          route(
            "openai-compatible",
            "openai",
            "https://api.openai.com/v1",
            model,
            effort,
            thinkingMode,
            null,
            EMPTY_SAMPLING_V2,
            reasoningEffort
          ),
          PROMPT,
          OMIT_CACHE
        ),
        /direct OpenAI Chat Completions adapter does not support this exact model\./u,
        `${model}/${effort}/${thinkingMode}/${reasoningEffort}`
      );
    }
  }
});

test("reasoning models are covered by the sampling catalogs", () => {
  const reasoningOpenAi = new Set([
    ...[...OPENAI_REASONING_CAPABILITIES.values()].map(({ model }) => model),
    ...[...SUBSCRIPTION_REASONING_CAPABILITIES.values()]
      .filter((capability) => capability.provider === "openai")
      .map(({ model }) => model)
  ]);
  const reasoningAnthropic = new Set([
    ...[...ANTHROPIC_REASONING_CAPABILITIES.values()].map(({ model }) => model),
    ...[...SUBSCRIPTION_REASONING_CAPABILITIES.values()]
      .filter((capability) => capability.provider === "anthropic")
      .map(({ model }) => model)
  ]);
  for (const model of reasoningOpenAi) {
    assert.equal(OPENAI_SAMPLING_RULES.has(model), true, `OpenAI model ${model}`);
  }
  for (const model of reasoningAnthropic) {
    assert.equal(ANTHROPIC_SAMPLING_RULES.has(model), true, `Anthropic model ${model}`);
  }
});

test("reasoning sampling fails closed when an exact sampling rule is missing", () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const result = resolveReasoningSampling({
      provider,
      remoteModelId: `${provider}-unlisted-model`,
      effectiveEffort: "medium",
      thinkingOn: true,
      temperature: null,
      sampling: EMPTY_SAMPLING_V2,
      tokenProbabilities: null
    });
    assert.equal(result.kind, "unavailable");
    if (result.kind === "unavailable") {
      assert.match(result.message, /missing from the sampling capability catalog/u);
    }
  }
});

test("OpenAI never-sampling models reject every serializable sampling field", async () => {
  const cases = [
    ["topP", { ...EMPTY_SAMPLING_V2, topP: 0.9 }],
    ["frequencyPenalty", { ...EMPTY_SAMPLING_V2, frequencyPenalty: 0.2 }],
    ["presencePenalty", { ...EMPTY_SAMPLING_V2, presencePenalty: 0.2 }],
    ["seed", { ...EMPTY_SAMPLING_V2, seed: 42 }],
    ["stop", { ...EMPTY_SAMPLING_V2, stop: ["END"] }]
  ] as const;

  for (const [knob, sampling] of cases) {
    await assert.rejects(
      buildOpenAiChatRequestBody(
        route("openai-compatible", "openai", "https://api.openai.com/v1", "gpt-5", "default", "default", null, sampling),
        PROMPT,
        OMIT_CACHE
      ),
      /does not accept sampling controls/u,
      `${knob} must be rejected by the never-sampling policy`
    );
  }
});

test("OpenAI never-sampling policy rejects a story-only bias overlay", async () => {
  await assert.rejects(
    buildOpenAiChatRequestBody(
      route("openai-compatible", "openai", "https://api.openai.com/v1", "gpt-5", "default", "default", null),
      PROMPT,
      OMIT_CACHE,
      { storySampling: { phraseBias: [{ phrase: "ember", weight: 1 }], bannedStrings: [] } }
    ),
    /does not accept sampling controls/u
  );
});

test("Anthropic Opus 5 emits adaptive summarized thinking by default", async () => {
  const settings = route("anthropic", "anthropic", "https://api.anthropic.com", "claude-opus-5", "default", "default", null);
  const body = await buildAnthropicMessagesRequestBody(settings, PROMPT, OMIT_CACHE);
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
  assert.equal("output_config" in body, false);
  assert.equal("temperature" in body, false);
});

test("Anthropic Opus 5 lowers disabled high thinking without a budget", async () => {
  const settings = route("anthropic", "anthropic", "https://api.anthropic.com", "claude-opus-5", "high", "off", null);
  const body = await buildAnthropicMessagesRequestBody(settings, PROMPT, OMIT_CACHE);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.equal("thinking_budget_tokens" in body, false);
});

test("Anthropic Opus 5 allows disabled thinking with default effort", async () => {
  const settings = route("anthropic", "anthropic", "https://api.anthropic.com", "claude-opus-5", "default", "off", null);
  const body = await buildAnthropicMessagesRequestBody(settings, PROMPT, OMIT_CACHE);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal("output_config" in body, false);
});

test("persisted unsupported vetoes Anthropic controls without blocking a default request", async () => {
  const body = await buildAnthropicMessagesRequestBody(
    route(
      "anthropic",
      "anthropic",
      "https://api.anthropic.com",
      "claude-opus-5",
      "default",
      "default",
      null,
      EMPTY_SAMPLING_V2,
      "unsupported"
    ),
    PROMPT,
    OMIT_CACHE
  );
  assert.equal("thinking" in body, false);
  assert.equal("output_config" in body, false);
});

test("unknown Anthropic model with persisted unsupported reasoning keeps default sampling", async () => {
  const body = await buildAnthropicMessagesRequestBody(
    route(
      "anthropic",
      "anthropic",
      "https://api.anthropic.com",
      "claude-3-5-sonnet",
      "default",
      "default",
      0.4,
      { ...EMPTY_SAMPLING_V2, stop: ["END"] },
      "unsupported"
    ),
    PROMPT,
    OMIT_CACHE
  );
  assert.equal(body.temperature, 0.4);
  assert.deepEqual(body.stop_sequences, ["END"]);
  assert.equal("thinking" in body, false);
  assert.equal("output_config" in body, false);

  await assert.rejects(
    buildAnthropicMessagesRequestBody(
      route(
        "anthropic",
        "anthropic",
        "https://api.anthropic.com",
        "claude-3-5-sonnet",
        "high",
        "default",
        null,
        EMPTY_SAMPLING_V2,
        "unsupported"
      ),
      PROMPT,
      OMIT_CACHE
    ),
    /explicitly disables reasoning controls/u
  );
});

test("Anthropic thinking omits temperature and top k but keeps valid top p", async () => {
  const sampling: SamplingSettingsV2 = { ...EMPTY_SAMPLING_V2, topP: 0.97, topK: 7 };
  const settings = route("anthropic", "anthropic", "https://api.anthropic.com", "claude-sonnet-4-6", "medium", "on", 0.4, sampling);
  const body = await buildAnthropicMessagesRequestBody(settings, PROMPT, OMIT_CACHE);
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(body.output_config && typeof body.output_config === "object" && "effort" in body.output_config
    ? body.output_config.effort : undefined, "medium");
  assert.equal(body.top_p, 0.97);
  assert.equal("top_k" in body, false);
  assert.equal("temperature" in body, false);
});

test("compatible Anthropic routes refuse temperature with top p before lowering", async () => {
  await assert.rejects(
    buildAnthropicMessagesRequestBody(
      route(
        "anthropic",
        "anthropic",
        "https://anthropic.example",
        "fixture-model",
        "default",
        "default",
        0.4,
        { ...EMPTY_SAMPLING_V2, topP: 0.97 }
      ),
      PROMPT,
      OMIT_CACHE
    ),
    /Compatible Anthropic requests cannot combine temperature with top p\./u
  );
});

test("Anthropic truncated models refuse temperature with top p when thinking is not on", async () => {
  await assert.rejects(
    buildAnthropicMessagesRequestBody(
      route(
        "anthropic",
        "anthropic",
        "https://api.anthropic.com",
        "claude-sonnet-4-6",
        "default",
        "default",
        0.4,
        { ...EMPTY_SAMPLING_V2, topP: 0.97 }
      ),
      PROMPT,
      OMIT_CACHE
    ),
    /cannot combine temperature with top p/u
  );
});

test("Anthropic newest-model sampling sees story bias before lowering", async () => {
  const settings = route("anthropic", "anthropic", "https://api.anthropic.com", "claude-opus-5", "default", "default", null);
  await assert.rejects(
    buildAnthropicMessagesRequestBody(settings, PROMPT, OMIT_CACHE, {
      storySampling: { phraseBias: [{ phrase: "ember", weight: 1 }], bannedStrings: [] }
    }),
    /does not accept custom sampling/
  );
});

test("compatible Anthropic routes refuse protocol-unsupported token probabilities", async () => {
  await assert.rejects(
    buildAnthropicMessagesRequestBody(
      route(
        "anthropic",
        "anthropic",
        "https://anthropic.example",
        "claude-opus-5",
        "default",
        "default",
        null,
        EMPTY_SAMPLING_V2,
        "unknown",
        4
      ),
      PROMPT,
      OMIT_CACHE
    ),
    /Token probabilities are unavailable with the selected reasoning state\./u
  );
});

test("Anthropic exact model groups lower their provider request shapes", async () => {
  const cases = [
    ["claude-fable-5", "max", { type: "adaptive", display: "summarized" }, "max"],
    ["claude-mythos-5", "max", { type: "adaptive", display: "summarized" }, "max"],
    ["claude-mythos-preview", "max", { type: "adaptive", display: "summarized" }, "max"],
    ["claude-opus-4-8", "max", undefined, "max"],
    ["claude-opus-4-7", "max", undefined, "max"],
    ["claude-sonnet-5", "max", { type: "adaptive", display: "summarized" }, "max"],
    ["claude-opus-4-6", "max", undefined, "max"],
    ["claude-opus-4-5", "high", undefined, "high"],
    ["claude-sonnet-4-5", "default", undefined, undefined],
    ["claude-haiku-4-5", "default", undefined, undefined]
  ] as const;
  for (const [model, effort, thinking, outputEffort] of cases) {
    const body = await buildAnthropicMessagesRequestBody(
      route("anthropic", "anthropic", "https://api.anthropic.com", model, effort, "default", null),
      PROMPT,
      OMIT_CACHE
    );
    assert.deepEqual(body.thinking, thinking);
    assert.equal(
      body.output_config && typeof body.output_config === "object" && "effort" in body.output_config
        ? body.output_config.effort
        : undefined,
      outputEffort
    );
  }
});

test("OpenAI exact ladders lower effort and effective-default sampling", async () => {
  const cases = [
    ["gpt-5.6", "max", "max", EMPTY_SAMPLING_V2],
    ["gpt-5.5", "xhigh", "xhigh", EMPTY_SAMPLING_V2],
    ["gpt-5.4", "default", undefined, { ...EMPTY_SAMPLING_V2, topP: 0.9 }],
    ["gpt-5.2-2025-12-11", "high", "high", EMPTY_SAMPLING_V2],
    ["gpt-5.1", "high", "high", EMPTY_SAMPLING_V2],
    ["gpt-5", "minimal", "minimal", EMPTY_SAMPLING_V2]
  ] as const;
  for (const [model, effort, wireEffort, sampling] of cases) {
    const body = await buildOpenAiChatRequestBody(
      route("openai-compatible", "openai", "https://api.openai.com/v1", model, effort, "default", null, sampling),
      PROMPT,
      OMIT_CACHE
    );
    assert.equal(body.reasoning_effort, wireEffort);
    if (model === "gpt-5.4") assert.equal(body.top_p, 0.9);
  }
});

function route(
  provider: GenerationSettings["provider"],
  preset: StandardModelConnectionV2["preset"],
  baseUrl: string,
  model: string,
  effort: "default" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  thinkingMode: "default" | "on" | "off",
  temperature: number | null = 0.4,
  sampling: SamplingSettingsV2 = EMPTY_SAMPLING_V2,
  reasoningEffort: ModelCapabilitiesV2["reasoningEffort"] = CAPABILITIES.reasoningEffort,
  tokenProbabilities: number | null = null
): GenerationSettings {
  const connection: StandardModelConnectionV2 = {
    name: "Reasoning fixture",
    preset,
    protocol: provider === "anthropic" ? "anthropic-messages" : "openai-chat-completions",
    baseUrl,
    auth: { type: "none" },
    headers: [],
    timeouts: { responseHeaderMs: 1000, firstTokenMs: 1000, idleMs: 1000, totalMs: 5000 }
  };
  const runtime = providerRuntimeFromV2(connection, effort, {
    ...CAPABILITIES,
    reasoningEffort
  }, {
    thinkingMode,
    sampling,
    tokenProbabilities
  });
  return attachProviderRuntime({
    provider,
    baseUrl,
    model,
    apiKeyEnv: null,
    temperature,
    maxTokens: 512,
    systemPrompt: "",
    contextWindow: null
  }, runtime);
}
