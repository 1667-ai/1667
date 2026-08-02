import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnthropicMessagesRequestBody,
  buildOpenAiChatRequestBody
} from "../server/provider-request-body.js";
import {
  attachProviderRuntime,
  type ProviderRuntime
} from "../server/provider-runtime.js";
import type { PromptCacheWirePlan } from "../server/provider-cache-policy.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import {
  EMPTY_SAMPLING_V2,
  type SamplingSettingsV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

const FORBIDDEN_CACHE_FIELDS = new Set([
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "prompt_cache_breakpoint",
  "cache_control"
]);

const PROMPT: PromptPlan = {
  operation: "continue",
  turns: [
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "author-brief",
        text: "Write with restraint.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "facts",
        text: "The lantern is blue.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "user",
      blocks: [
        {
          stability: "stable",
          kind: "source",
          text: "Rain crossed the window.",
          boundaryAfter: "candidate"
        },
        {
          stability: "volatile",
          kind: "request",
          text: "\nContinue.",
          boundaryAfter: "none"
        }
      ]
    }
  ]
};

const AUTHORS_NOTE_PROMPT: PromptPlan = {
  operation: "continue",
  turns: [
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "author-brief",
        text: "Write with restraint.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "facts",
        text: "The lantern is blue.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "user",
      blocks: [{
        stability: "stable",
        kind: "source",
        text: "Open the door.",
        boundaryAfter: "none"
      }]
    },
    {
      role: "assistant",
      blocks: [{
        stability: "stable",
        kind: "source",
        text: "The latch clicked.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "authors-note",
        text: "Keep the danger quiet.",
        boundaryAfter: "none"
      }]
    },
    {
      role: "user",
      blocks: [{
        stability: "stable",
        kind: "source",
        text: "A stranger enters.",
        boundaryAfter: "none"
      }]
    },
    {
      role: "assistant",
      blocks: [{
        stability: "stable",
        kind: "source",
        text: "The room held its breath.",
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

// A deeper Author's Note placement: three story parts, note two parts from
// the end (depth 2), not immediately before the last part.
const AUTHORS_NOTE_DEEP_PROMPT: PromptPlan = {
  operation: "continue",
  turns: [
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "author-brief",
        text: "Write with restraint.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "facts",
        text: "The lantern is blue.",
        boundaryAfter: "candidate"
      }]
    },
    {
      role: "user",
      blocks: [{ stability: "stable", kind: "source", text: "Open the door.", boundaryAfter: "none" }]
    },
    {
      role: "assistant",
      blocks: [{ stability: "stable", kind: "source", text: "The latch clicked.", boundaryAfter: "none" }]
    },
    {
      role: "system",
      blocks: [{
        stability: "stable",
        kind: "authors-note",
        text: "Keep the danger quiet.",
        boundaryAfter: "none"
      }]
    },
    {
      role: "user",
      blocks: [{ stability: "stable", kind: "source", text: "A stranger enters.", boundaryAfter: "none" }]
    },
    {
      role: "assistant",
      blocks: [{ stability: "stable", kind: "source", text: "The room held its breath.", boundaryAfter: "none" }]
    },
    {
      role: "user",
      blocks: [{ stability: "stable", kind: "source", text: "Footsteps recede.", boundaryAfter: "none" }]
    },
    {
      role: "assistant",
      blocks: [{ stability: "stable", kind: "source", text: "Silence returned.", boundaryAfter: "candidate" }]
    },
    {
      role: "user",
      blocks: [{ stability: "volatile", kind: "request", text: "Continue.", boundaryAfter: "none" }]
    }
  ]
};

const OMIT_PLANS: readonly Extract<PromptCacheWirePlan, { kind: "omit" }>[] = [
  { kind: "omit", reason: "policy-off" },
  { kind: "omit", reason: "legacy-v1" },
  { kind: "omit", reason: "dry-run" },
  { kind: "omit", reason: "no-stable-boundary" }
];

test("OpenAI chat request lowering preserves exact current wire bytes", () => {
  const body = buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, OMIT_PLANS[0]!);
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Rain crossed the window.\\nContinue.\"}],\"max_tokens\":321,\"stream\":true,\"temperature\":0.25}"
  );
});

test("Anthropic request lowering preserves exact current system and message bytes", () => {
  const body = buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, OMIT_PLANS[0]!);
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"max_tokens\":321,\"messages\":[{\"role\":\"user\",\"content\":\"Rain crossed the window.\\nContinue.\"}],\"stream\":true,\"system\":\"Write with restraint.\\n\\nThe lantern is blue.\",\"temperature\":0.25}"
  );
});

test("compatible OpenAI and Anthropic endpoints fold the note into the next user turn", () => {
  const openAi = buildOpenAiChatRequestBody(
    settings("openai-compatible"),
    AUTHORS_NOTE_PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(
    JSON.stringify(openAi),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Open the door.\"},{\"role\":\"assistant\",\"content\":\"The latch clicked.\"},{\"role\":\"user\",\"content\":\"Keep the danger quiet.\\n\\nA stranger enters.\"},{\"role\":\"assistant\",\"content\":\"The room held its breath.\"},{\"role\":\"user\",\"content\":\"Continue.\"}],\"max_tokens\":321,\"stream\":true,\"temperature\":0.25}"
  );

  const anthropic = buildAnthropicMessagesRequestBody(
    settings("anthropic"),
    AUTHORS_NOTE_PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(
    JSON.stringify(anthropic),
    "{\"model\":\"model-fixture\",\"max_tokens\":321,\"messages\":[{\"role\":\"user\",\"content\":\"Open the door.\"},{\"role\":\"assistant\",\"content\":\"The latch clicked.\"},{\"role\":\"user\",\"content\":\"Keep the danger quiet.\\n\\nA stranger enters.\"},{\"role\":\"assistant\",\"content\":\"The room held its breath.\"},{\"role\":\"user\",\"content\":\"Continue.\"}],\"stream\":true,\"system\":\"Write with restraint.\\n\\nThe lantern is blue.\",\"temperature\":0.25}"
  );
});

test("compatible OpenAI and Anthropic endpoints fold the note at a deeper placement, not just depth one", () => {
  const openAi = buildOpenAiChatRequestBody(
    settings("openai-compatible"),
    AUTHORS_NOTE_DEEP_PROMPT,
    OMIT_PLANS[0]!
  ) as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(
    openAi.messages.map((message) => message.content),
    [
      "Write with restraint.",
      "The lantern is blue.",
      "Open the door.",
      "The latch clicked.",
      "Keep the danger quiet.\n\nA stranger enters.",
      "The room held its breath.",
      "Footsteps recede.",
      "Silence returned.",
      "Continue."
    ]
  );

  const anthropic = buildAnthropicMessagesRequestBody(
    settings("anthropic"),
    AUTHORS_NOTE_DEEP_PROMPT,
    OMIT_PLANS[0]!
  ) as { system: string; messages: Array<{ role: string; content: string }> };
  assert.equal(anthropic.system, "Write with restraint.\n\nThe lantern is blue.");
  assert.deepEqual(
    anthropic.messages.map((message) => message.content),
    [
      "Open the door.",
      "The latch clicked.",
      "Keep the danger quiet.\n\nA stranger enters.",
      "The room held its breath.",
      "Footsteps recede.",
      "Silence returned.",
      "Continue."
    ]
  );
});

test("official OpenAI Chat Completions keeps the late system note", () => {
  const body = buildOpenAiChatRequestBody(
    { ...settings("openai-compatible"), baseUrl: "https://api.openai.com/v1" },
    AUTHORS_NOTE_PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Open the door.\"},{\"role\":\"assistant\",\"content\":\"The latch clicked.\"},{\"role\":\"system\",\"content\":\"Keep the danger quiet.\"},{\"role\":\"user\",\"content\":\"A stranger enters.\"},{\"role\":\"assistant\",\"content\":\"The room held its breath.\"},{\"role\":\"user\",\"content\":\"Continue.\"}],\"max_tokens\":321,\"stream\":true,\"temperature\":0.25}"
  );
});

test("all omission plans send no optional cache controls", () => {
  for (const cache of OMIT_PLANS) {
    for (const build of [buildOpenAiChatRequestBody, buildAnthropicMessagesRequestBody]) {
      const body = build({ ...settings("anthropic"), temperature: null }, PROMPT, cache);
      assert.equal(hasForbiddenCacheField(body), false, `${build.name}: ${cache.reason}`);
      assert.equal(Object.hasOwn(body, "temperature"), false);
    }
  }
});

test("legacy OpenAI automatic caching uses the exact stable key and retention fields", () => {
  const body = buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
    kind: "openai-automatic",
    key: "st:v1:fixture:continue",
    retention: "24h"
  });
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Rain crossed the window.\\nContinue.\"}],\"max_tokens\":321,\"stream\":true,\"prompt_cache_key\":\"st:v1:fixture:continue\",\"prompt_cache_retention\":\"24h\",\"temperature\":0.25}"
  );
});

test("newer OpenAI caching adds key, explicit mode, and stable breakpoints atomically", () => {
  const body = buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
    kind: "openai-explicit",
    key: "st:v1:fixture:continue",
    breakpoints: [
      { turn: 0, block: 0 },
      { turn: 2, block: 0 }
    ]
  });
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":[{\"type\":\"text\",\"text\":\"Write with restraint.\",\"prompt_cache_breakpoint\":{\"mode\":\"explicit\"}}]},{\"role\":\"system\",\"content\":[{\"type\":\"text\",\"text\":\"The lantern is blue.\"}]},{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Rain crossed the window.\",\"prompt_cache_breakpoint\":{\"mode\":\"explicit\"}},{\"type\":\"text\",\"text\":\"\\nContinue.\"}]}],\"max_tokens\":321,\"stream\":true,\"prompt_cache_key\":\"st:v1:fixture:continue\",\"prompt_cache_options\":{\"mode\":\"explicit\"},\"temperature\":0.25}"
  );
  assert.equal(
    JSON.stringify(body).includes("\"text\":\"\\nContinue.\",\"prompt_cache_breakpoint\""),
    false,
    "the volatile request block can never receive a breakpoint"
  );
});

test("newer OpenAI off explicitly suppresses automatic latest-message caching", () => {
  const body = buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
    kind: "openai-explicit-off"
  });
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
  assert.equal(Object.hasOwn(body, "prompt_cache_key"), false);
  assert.equal(JSON.stringify(body).includes("prompt_cache_breakpoint"), false);
});

test("Anthropic auto and long put the only cache control on the stable boundary", () => {
  const auto = buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, {
    kind: "anthropic-explicit",
    ttl: "5m",
    breakpoint: { turn: 2, block: 0 }
  });
  assert.equal(
    JSON.stringify(auto),
    "{\"model\":\"model-fixture\",\"max_tokens\":321,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Rain crossed the window.\",\"cache_control\":{\"type\":\"ephemeral\"}},{\"type\":\"text\",\"text\":\"\\nContinue.\"}]}],\"stream\":true,\"system\":[{\"type\":\"text\",\"text\":\"Write with restraint.\\n\\n\"},{\"type\":\"text\",\"text\":\"The lantern is blue.\"}],\"temperature\":0.25}"
  );
  const long = buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, {
    kind: "anthropic-explicit",
    ttl: "1h",
    breakpoint: { turn: 2, block: 0 }
  });
  const serialized = JSON.stringify(long);
  assert.equal(countOccurrences(serialized, "\"cache_control\""), 1);
  assert.match(serialized, /"cache_control":\{"type":"ephemeral","ttl":"1h"\}/);
  assert.equal(
    serialized.includes("\"text\":\"\\nContinue.\",\"cache_control\""),
    false,
    "the volatile request block can never receive a cache control"
  );
});

test("Anthropic note folding preserves the explicit cache boundary", () => {
  const body = buildAnthropicMessagesRequestBody(settings("anthropic"), AUTHORS_NOTE_PROMPT, {
    kind: "anthropic-explicit",
    ttl: "5m",
    breakpoint: { turn: 3, block: 0 }
  });
  const serialized = JSON.stringify(body);

  assert.equal(countOccurrences(serialized, "\"cache_control\""), 1);
  assert.match(
    serialized,
    /"text":"The latch clicked\.","cache_control":\{"type":"ephemeral"\}/
  );
  assert.match(serialized, /"text":"Keep the danger quiet\.\\n\\nA stranger enters\."/);
  assert.equal(JSON.stringify(body.system).includes("Keep the danger quiet."), false);
});

test("provider serializers reject cache markers outside stable candidate blocks", () => {
  assert.throws(
    () => buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
      kind: "openai-explicit",
      key: "scope",
      breakpoints: [{ turn: 2, block: 1 }]
    }),
    /not a stable candidate/
  );
  assert.throws(
    () => buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, {
      kind: "anthropic-explicit",
      ttl: "5m",
      breakpoint: { turn: 9, block: 9 }
    }),
    /outside the prompt/
  );
});

test("explicit supported effort lowers through each protocol adapter", () => {
  const openAi = buildOpenAiChatRequestBody(
    withEffort(settings("openai-compatible"), "high"),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(openAi.reasoning_effort, "high");

  const anthropic = buildAnthropicMessagesRequestBody(
    withEffort(settings("anthropic"), "low"),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.deepEqual(anthropic.output_config, { effort: "low" });

  assert.throws(
    () => buildAnthropicMessagesRequestBody(
      withEffort(settings("anthropic"), "off"),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /does not define a generation-effort mapping for off/
  );
});

test("a model that declares no sampling support keeps temperature off the wire", () => {
  for (const provider of ["anthropic", "openai-compatible"] as const) {
    const build = provider === "anthropic"
      ? buildAnthropicMessagesRequestBody
      : buildOpenAiChatRequestBody;
    const base = settings(provider);
    assert.equal(
      build(withTemperatureSupport(base, "supported"), PROMPT, OMIT_PLANS[0]!).temperature,
      0.25
    );
    assert.equal(
      "temperature" in build(
        withTemperatureSupport(base, "unsupported"),
        PROMPT,
        OMIT_PLANS[0]!
      ),
      false
    );
  }
});

test("OpenAI-compatible serializers lower the documented baseline and preset extensions", () => {
  const full = sampling({
    topP: 0.91,
    topK: 41,
    minP: 0.05,
    frequencyPenalty: 0.2,
    presencePenalty: -0.1,
    repeatPenalty: 1.1,
    seed: 42,
    stop: ["END", "DONE"],
    logitBias: { "15043": 1, "198": -2 }
  });
  const llama = buildOpenAiChatRequestBody(
    withSampling(settings("openai-compatible"), "llama-cpp", full),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.deepEqual({
    top_p: llama.top_p,
    top_k: llama.top_k,
    min_p: llama.min_p,
    frequency_penalty: llama.frequency_penalty,
    presence_penalty: llama.presence_penalty,
    repeat_penalty: llama.repeat_penalty,
    seed: llama.seed,
    stop: llama.stop,
    logit_bias: llama.logit_bias
  }, {
    top_p: 0.91,
    top_k: 41,
    min_p: 0.05,
    frequency_penalty: 0.2,
    presence_penalty: -0.1,
    repeat_penalty: 1.1,
    seed: 42,
    stop: ["END", "DONE"],
    logit_bias: { "198": -2, "15043": 1 }
  });

  const lmStudio = buildOpenAiChatRequestBody(
    withSampling(settings("openai-compatible"), "lm-studio", { ...full, minP: null }),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal("min_p" in lmStudio, false);
  assert.equal(lmStudio.top_k, 41);
  assert.equal(lmStudio.repeat_penalty, 1.1);
  assert.equal(lmStudio.seed, 42);

  const ollama = buildOpenAiChatRequestBody(
    withSampling(settings("openai-compatible"), "ollama", {
      ...full,
      topK: null,
      minP: null,
      repeatPenalty: null,
      logitBias: {}
    }),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal("logit_bias" in ollama, false);
  assert.equal("top_k" in ollama, false);
  assert.equal(ollama.top_p, 0.91);
  assert.equal(ollama.seed, 42);

  const kobold = buildOpenAiChatRequestBody(
    withSampling(settings("openai-compatible"), "koboldcpp", {
      ...full,
      frequencyPenalty: null
    }),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal("frequency_penalty" in kobold, false);
  assert.equal(kobold.min_p, 0.05);
  assert.equal(kobold.seed, 42);

  const custom = buildOpenAiChatRequestBody(
    withSampling(settings("openai-compatible"), "custom", {
      ...full,
      topK: null,
      minP: null,
      repeatPenalty: null
    }),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(custom.top_p, 0.91);
  assert.equal(custom.frequency_penalty, 0.2);
  assert.equal("top_k" in custom, false);
  assert.equal(custom.seed, 42);
});

test("Anthropic lowering uses only its exact wire names", () => {
  const body = buildAnthropicMessagesRequestBody(
    withSampling({ ...settings("anthropic"), model: "claude-opus-4-5" }, "anthropic", sampling({
      topP: 0.9,
      topK: 32,
      stop: ["END"]
    })),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(body.top_p, 0.9);
  assert.equal("temperature" in body, false);
  assert.equal(body.top_k, 32);
  assert.deepEqual(body.stop_sequences, ["END"]);
  for (const field of [
    "stop",
    "min_p",
    "logit_bias",
    "frequency_penalty",
    "presence_penalty",
    "repeat_penalty"
  ]) assert.equal(field in body, false, field);
});

test("serializers refuse configured sampling values that the selected route cannot lower", () => {
  const cases: readonly [string, SamplingSettingsV2][] = [
    ["top k", sampling({ topK: 32 })],
    ["min p", sampling({ minP: 0.05 })],
    ["repeat penalty", sampling({ repeatPenalty: 1.1 })]
  ];
  for (const [field, value] of cases) {
    const settingsValue = withSampling(settings("openai-compatible"), "custom", value);
    assert.throws(
      () => buildOpenAiChatRequestBody(settingsValue, PROMPT, OMIT_PLANS[0]!),
      new RegExp(`Configured sampling parameter ${field}`)
    );
  }
  assert.throws(
    () => buildOpenAiChatRequestBody(
      withSampling(settings("openai-compatible"), "ollama", sampling({ logitBias: { "1": 1 } })),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter logit bias/
  );
  assert.throws(
    () => buildAnthropicMessagesRequestBody(
      withSampling({ ...settings("anthropic"), model: "claude-opus-4-5" }, "anthropic", sampling({ frequencyPenalty: 0.2 })),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter frequency penalty/
  );
  assert.throws(
    () => buildAnthropicMessagesRequestBody(
      withSampling({ ...settings("anthropic"), model: "claude-opus-4-5" }, "anthropic", sampling({ seed: 42 })),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter seed/
  );
});

function withTemperatureSupport(
  value: GenerationSettings,
  temperature: ProviderRuntime["capabilities"]["temperature"]
): GenerationSettings {
  return attachProviderRuntime({ ...value }, {
    preset: "custom",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "default",
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature,
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

function withSampling(
  value: GenerationSettings,
  preset: ProviderRuntime["preset"],
  sampling: SamplingSettingsV2
): GenerationSettings {
  return attachProviderRuntime({ ...value }, {
    preset,
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort: "default",
    sampling,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  }, true);
}

function sampling(overrides: Partial<SamplingSettingsV2> = {}): SamplingSettingsV2 {
  return {
    ...EMPTY_SAMPLING_V2,
    ...overrides,
    stop: overrides.stop ?? EMPTY_SAMPLING_V2.stop,
    logitBias: overrides.logitBias ?? EMPTY_SAMPLING_V2.logitBias
  };
}

function settings(provider: GenerationSettings["provider"]): GenerationSettings {
  return {
    provider,
    baseUrl: "https://provider.example/v1",
    model: "model-fixture",
    apiKeyEnv: null,
    temperature: 0.25,
    maxTokens: 321,
    systemPrompt: "unused by prompt-plan lowering",
    contextWindow: null
  };
}

function withEffort(
  value: GenerationSettings,
  effort: ProviderRuntime["effort"]
): GenerationSettings {
  return attachProviderRuntime(value, {
    preset: "custom",
    auth: { type: "none" },
    headers: [],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    },
    allowInsecureHttp: false,
    effort,
    sampling: EMPTY_SAMPLING_V2,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "supported",
      promptCaching: "unknown"
    }
  }, true);
}

function hasForbiddenCacheField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenCacheField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_CACHE_FIELDS.has(key) || hasForbiddenCacheField(child));
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
