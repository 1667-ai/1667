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
import type { StorySamplingBias } from "../server/sampling-phrase-bias.js";

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

test("OpenAI chat request lowering preserves exact current wire bytes", async () => {
  const body = await buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, OMIT_PLANS[0]!);
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Rain crossed the window.\\nContinue.\"}],\"max_tokens\":321,\"stream\":true,\"temperature\":0.25}"
  );
});

test("Anthropic request lowering preserves exact current system and message bytes", async () => {
  const body = await buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, OMIT_PLANS[0]!);
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"max_tokens\":321,\"messages\":[{\"role\":\"user\",\"content\":\"Rain crossed the window.\\nContinue.\"}],\"stream\":true,\"system\":\"Write with restraint.\\n\\nThe lantern is blue.\",\"temperature\":0.25}"
  );
});

test("compatible OpenAI and Anthropic endpoints fold the note into the next user turn", async () => {
  const openAi = await buildOpenAiChatRequestBody(
    settings("openai-compatible"),
    AUTHORS_NOTE_PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(
    JSON.stringify(openAi),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Open the door.\"},{\"role\":\"assistant\",\"content\":\"The latch clicked.\"},{\"role\":\"user\",\"content\":\"Keep the danger quiet.\\n\\nA stranger enters.\"},{\"role\":\"assistant\",\"content\":\"The room held its breath.\"},{\"role\":\"user\",\"content\":\"Continue.\"}],\"max_tokens\":321,\"stream\":true,\"temperature\":0.25}"
  );

  const anthropic = await buildAnthropicMessagesRequestBody(
    settings("anthropic"),
    AUTHORS_NOTE_PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(
    JSON.stringify(anthropic),
    "{\"model\":\"model-fixture\",\"max_tokens\":321,\"messages\":[{\"role\":\"user\",\"content\":\"Open the door.\"},{\"role\":\"assistant\",\"content\":\"The latch clicked.\"},{\"role\":\"user\",\"content\":\"Keep the danger quiet.\\n\\nA stranger enters.\"},{\"role\":\"assistant\",\"content\":\"The room held its breath.\"},{\"role\":\"user\",\"content\":\"Continue.\"}],\"stream\":true,\"system\":\"Write with restraint.\\n\\nThe lantern is blue.\",\"temperature\":0.25}"
  );
});

test("compatible OpenAI and Anthropic endpoints fold the note at a deeper placement, not just depth one", async () => {
  const openAi = await buildOpenAiChatRequestBody(
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

  const anthropic = await buildAnthropicMessagesRequestBody(
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

test("official OpenAI Chat Completions keeps the late system note", async () => {
  const body = await buildOpenAiChatRequestBody(
    { ...settings("openai-compatible"), baseUrl: "https://api.openai.com/v1" },
    AUTHORS_NOTE_PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Open the door.\"},{\"role\":\"assistant\",\"content\":\"The latch clicked.\"},{\"role\":\"system\",\"content\":\"Keep the danger quiet.\"},{\"role\":\"user\",\"content\":\"A stranger enters.\"},{\"role\":\"assistant\",\"content\":\"The room held its breath.\"},{\"role\":\"user\",\"content\":\"Continue.\"}],\"max_tokens\":321,\"stream\":true,\"temperature\":0.25}"
  );
});

test("all omission plans send no optional cache controls", async () => {
  for (const cache of OMIT_PLANS) {
    for (const build of [buildOpenAiChatRequestBody, buildAnthropicMessagesRequestBody]) {
      const body = await build({ ...settings("anthropic"), temperature: null }, PROMPT, cache);
      assert.equal(hasForbiddenCacheField(body), false, `${build.name}: ${cache.reason}`);
      assert.equal(Object.hasOwn(body, "temperature"), false);
    }
  }
});

test("legacy OpenAI automatic caching uses the exact stable key and retention fields", async () => {
  const body = await buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
    kind: "openai-automatic",
    key: "st:v1:fixture:continue",
    retention: "24h"
  });
  assert.equal(
    JSON.stringify(body),
    "{\"model\":\"model-fixture\",\"messages\":[{\"role\":\"system\",\"content\":\"Write with restraint.\"},{\"role\":\"system\",\"content\":\"The lantern is blue.\"},{\"role\":\"user\",\"content\":\"Rain crossed the window.\\nContinue.\"}],\"max_tokens\":321,\"stream\":true,\"prompt_cache_key\":\"st:v1:fixture:continue\",\"prompt_cache_retention\":\"24h\",\"temperature\":0.25}"
  );
});

test("newer OpenAI caching adds key, explicit mode, and stable breakpoints atomically", async () => {
  const body = await buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
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

test("newer OpenAI off explicitly suppresses automatic latest-message caching", async () => {
  const body = await buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
    kind: "openai-explicit-off"
  });
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
  assert.equal(Object.hasOwn(body, "prompt_cache_key"), false);
  assert.equal(JSON.stringify(body).includes("prompt_cache_breakpoint"), false);
});

test("Anthropic auto and long put the only cache control on the stable boundary", async () => {
  const auto = await buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, {
    kind: "anthropic-explicit",
    ttl: "5m",
    breakpoint: { turn: 2, block: 0 }
  });
  assert.equal(
    JSON.stringify(auto),
    "{\"model\":\"model-fixture\",\"max_tokens\":321,\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Rain crossed the window.\",\"cache_control\":{\"type\":\"ephemeral\"}},{\"type\":\"text\",\"text\":\"\\nContinue.\"}]}],\"stream\":true,\"system\":[{\"type\":\"text\",\"text\":\"Write with restraint.\\n\\n\"},{\"type\":\"text\",\"text\":\"The lantern is blue.\"}],\"temperature\":0.25}"
  );
  const long = await buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, {
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

test("Anthropic note folding preserves the explicit cache boundary", async () => {
  const body = await buildAnthropicMessagesRequestBody(settings("anthropic"), AUTHORS_NOTE_PROMPT, {
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

test("provider serializers reject cache markers outside stable candidate blocks", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(settings("openai-compatible"), PROMPT, {
      kind: "openai-explicit",
      key: "scope",
      breakpoints: [{ turn: 2, block: 1 }]
    }),
    /not a stable candidate/
  );
  await assert.rejects(
    () => buildAnthropicMessagesRequestBody(settings("anthropic"), PROMPT, {
      kind: "anthropic-explicit",
      ttl: "5m",
      breakpoint: { turn: 9, block: 9 }
    }),
    /outside the prompt/
  );
});

test("explicit supported effort lowers through each protocol adapter", async () => {
  const openAi = await buildOpenAiChatRequestBody(
    withEffort(settings("openai-compatible"), "high"),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal(openAi.reasoning_effort, "high");

  const anthropic = await buildAnthropicMessagesRequestBody(
    withEffort(settings("anthropic"), "low"),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.deepEqual(anthropic.output_config, { effort: "low" });

  await assert.rejects(
    () => buildAnthropicMessagesRequestBody(
      withEffort(settings("anthropic"), "off"),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /does not define a generation-effort mapping for off/
  );
});

test("a model that declares no sampling support keeps temperature off the wire", async () => {
  for (const provider of ["anthropic", "openai-compatible"] as const) {
    const build = provider === "anthropic"
      ? buildAnthropicMessagesRequestBody
      : buildOpenAiChatRequestBody;
    const base = settings(provider);
    assert.equal(
      (await build(withTemperatureSupport(base, "supported"), PROMPT, OMIT_PLANS[0]!)).temperature,
      0.25
    );
    assert.equal(
      "temperature" in await build(
        withTemperatureSupport(base, "unsupported"),
        PROMPT,
        OMIT_PLANS[0]!
      ),
      false
    );
  }
});

test("OpenAI-compatible serializers lower the documented baseline and preset extensions", async () => {
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
  const llama = await buildOpenAiChatRequestBody(
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

  const lmStudio = await buildOpenAiChatRequestBody(
    withSampling(settings("openai-compatible"), "lm-studio", { ...full, minP: null }),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.equal("min_p" in lmStudio, false);
  assert.equal(lmStudio.top_k, 41);
  assert.equal(lmStudio.repeat_penalty, 1.1);
  assert.equal(lmStudio.seed, 42);

  const ollama = await buildOpenAiChatRequestBody(
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

  const kobold = await buildOpenAiChatRequestBody(
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

  const custom = await buildOpenAiChatRequestBody(
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

// Issue #282 stage 1: a phrase resolves to token IDs and merges into
// logit_bias the same as a raw numeric entry — but only once every one of
// its four surface variants (typed, leading space, capitalized, leading
// space capitalized) is exactly one token. Exact IDs confirmed against the
// compiled tiktoken o200k_base encoder for "hello"/"Hello"/" hello"/" Hello".
test("a single-token phrase resolves into logit_bias entries for every surface variant", async () => {
  const body = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ phraseBias: [{ phrase: "hello", weight: 3 }] })
    ),
    PROMPT,
    OMIT_PLANS[0]!
  );
  assert.deepEqual(body.logit_bias, {
    "24912": 3,
    "40617": 3,
    "13225": 3,
    "32949": 3
  });
});

// Regression test for issue #282 review round 3, finding 1: variant
// expansion makes two phrase-bias entries collide unavoidably whenever one
// phrase's variants are a strict subset of another's — every variant of
// "Hello" (typed/capitalized both "Hello", leading-space/leading-space-
// capitalized both " Hello") is also a variant of "hello". An earlier
// version decided ownership using a different order than the merge itself,
// which silently dropped "hello"'s two *exclusive* tokens (24912, 40617)
// whenever "Hello" was configured too — even though the two entries here
// write the exact same weight and never actually conflict. Both orderings
// below must resolve cleanly and produce the identical, fully-covered
// merged map: which entry a writer types first must not change what
// reaches the wire when nothing about the two entries actually disagrees.
test("two phrase-bias entries that agree on a shared token's weight both resolve, in either typing order, covering every token", async () => {
  const inOrder = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({
        phraseBias: [
          { phrase: "hello", weight: -20 },
          { phrase: "Hello", weight: -20 }
        ]
      })
    ),
    PROMPT,
    OMIT_PLANS[0]!
  );
  const reversed = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({
        phraseBias: [
          { phrase: "Hello", weight: -20 },
          { phrase: "hello", weight: -20 }
        ]
      })
    ),
    PROMPT,
    OMIT_PLANS[0]!
  );
  const expected = { "24912": -20, "40617": -20, "13225": -20, "32949": -20 };
  assert.deepEqual(inOrder.logit_bias, expected);
  assert.deepEqual(reversed.logit_bias, expected);
});

// Decisive regression test for issue #282 review round 3, finding 1, in the
// exact shape the finding reproduced: two banned strings whose token sets
// overlap (bannedStrings always write the same fixed minimum weight, so two
// of them never have a real conflict to resolve) must ban every one of
// their combined tokens, and produce the exact same merged map regardless
// of which one was typed first.
test("banning two overlapping phrases bans every one of their tokens, and produces the same map in either order", async () => {
  const inOrder = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ bannedStrings: ["hello", "Hello"] })
    ),
    PROMPT,
    OMIT_PLANS[0]!
  );
  const reversed = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ bannedStrings: ["Hello", "hello"] })
    ),
    PROMPT,
    OMIT_PLANS[0]!
  );
  const expected = { "24912": -100, "40617": -100, "13225": -100, "32949": -100 };
  assert.deepEqual(inOrder.logit_bias, expected);
  assert.deepEqual(reversed.logit_bias, expected);
});

// Regression test for issue #282 review round 3, finding 2: a real weight
// conflict — not mere overlap — must block the request instead of silently
// shipping "Hello"'s weight for two of "hello"'s four tokens while dropping
// "hello"'s own weight entirely. The message names exactly which surface
// forms lost their bias.
test("a phrase-bias entry with a real weight conflict on some of its tokens blocks the request", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "gpt-4o" },
        "openai",
        sampling({
          phraseBias: [
            { phrase: "hello", weight: 20 },
            { phrase: "Hello", weight: -20 }
          ]
        })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Could not use "hello" as configured: "hello" loses its bias on "Hello", " Hello" to phrase bias "Hello"/
  );
});

// Regression test for issue #282 review round 3, finding 4: an explicit
// numeric logitBias entry escaped the ownership pass entirely, so a phrase
// it fully overrode was still reported "resolved" with all four token IDs —
// the editor showed it working while its own weight reached nothing. Now
// the same weight comparison catches a numeric override too, and blocks
// instead of silently shipping the numeric weights under the phrase's name.
test("an explicit numeric logitBias entry that overrides every one of a phrase's tokens blocks the request", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "gpt-4o" },
        "openai",
        sampling({
          logitBias: { "24912": 50, "40617": 50, "13225": 50, "32949": 50 },
          phraseBias: [{ phrase: "hello", weight: -100 }]
        })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /to an explicit numeric logit-bias entry, which takes precedence there/
  );
});

// Regression test for issue #282 review round 4, finding 1: a shadowed
// entry can lose different tokens to two different owners in the same
// message. "hello" tokenizes to four distinct ids — typed 24912, leading
// -space 40617, capitalized 13225, leading-space-capitalized 32949 — while
// "Hello" only ever produces two of those (13225, 32949; capitalizing
// "Hello" is a no-op, so its typed and leading-space variants collapse onto
// the same text as its capitalized ones). An explicit numeric logitBias
// entry on 24912 — a token "Hello" never names — and phraseBias "Hello"
// overriding 13225/32949 must each be named against the exact forms they
// actually took. The earlier implementation picked the owner of whichever
// conflicting token happened to be `tokenIds[0]` and blamed every lost form
// on that one owner, which would have reported "Hello" and " Hello" as
// having been taken by the numeric entry — false, since the numeric entry
// never named either of those tokens.
test("a phrase-bias entry whose lost tokens split across two different owners names each owner correctly", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "gpt-4o" },
        "openai",
        sampling({
          logitBias: { "24912": -50 },
          phraseBias: [
            { phrase: "hello", weight: 5 },
            { phrase: "Hello", weight: 9 }
          ]
        })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /"hello" loses its bias on "hello" to an explicit numeric logit-bias entry, which takes precedence there; and on "Hello", " Hello" to phrase bias "Hello", which takes precedence there/
  );
});

// Regression test for issue #282 stage 1, point 1: resolution used to spread
// a phrase's weight across every one of its tokens instead of refusing a
// multi-token phrase. "hello world" needs two tokens in every variant, so
// the request must never serialize a partial or approximated bias for it.
test("a phrase that needs more than one token in any variant is rejected, and the request never serializes it", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "gpt-4o" },
        "openai",
        sampling({ phraseBias: [{ phrase: "hello world", weight: 3 }] })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /"hello world" is 2 tokens \(24912,2375\), not one/
  );
});

// Regression test for issue #282 stage 1, point 2: "curse" is one token as
// typed, so a design that only checked the typed form would have accepted
// it — but its capitalized form (the form it takes at a sentence start) is
// two tokens. Variant expansion is what catches this.
test("variant expansion rejects a phrase whose typed form is single-token but whose capitalized form is not", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "gpt-4o" },
        "openai",
        sampling({ phraseBias: [{ phrase: "curse", weight: -2 }] })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /"Curse" \(capitalized\) is 2 tokens \(17532,344\), not one/
  );
});

// Issue #282 stage 1, point 4: OpenRouter routes a model ID to arbitrary
// providers and families, so the vocabulary that will actually serve a
// request is unknowable client-side — phrase bias stays unavailable there
// the same as on the self-hosted presets with no trusted tokenizer.
test("phrase bias is unavailable on OpenRouter, and the request never serializes it", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        settings("openai-compatible"),
        "openrouter",
        sampling({ phraseBias: [{ phrase: "hello", weight: 1 }] })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter phrase bias is unavailable/
  );
});

// Issue #282 stage 1, point 3: reasoning-family OpenAI models reject
// logit_bias outright — this gates logitBias itself, not only phraseBias
// and bannedStrings, because a raw token ID rides the same wire field.
test("logit bias is unavailable on a reasoning-family OpenAI model", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "o3-mini" },
        "openai",
        sampling({ logitBias: { "15043": 1 } })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter logit bias is unavailable/
  );
});

// Issue #282 stage 1, point 5: llama-cpp resolves phrase bias by asking the
// live server to tokenize (server/context-probe.ts, probeLlamaCppTokenize)
// rather than trusting a reported model name. "provider.example" is an
// RFC 2606 reserved domain that never resolves, so the probe fails the same
// way an unreachable server would — the request must report the tokenizer
// as unavailable, never send a request built from a failed probe.
test("a failed llama.cpp tokenize probe reports the tokenizer as unavailable, and the request never serializes a partial bias", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        settings("openai-compatible"),
        "llama-cpp",
        sampling({ phraseBias: [{ phrase: "hello", weight: 1 }] })
      ),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /the llama\.cpp tokenize probe did not answer/
  );
});

// Issue #341: a story's own phraseBias/bannedStrings overlay adds to the
// routed profile's — the same resolution `resolveSamplingBiasForSettings`
// (server/sampling-phrase-bias.ts) applies, at the exact boundary the
// request itself serializes through, not a parallel check. The profile
// contributes a raw numeric logitBias entry here (a token id needing no
// tokenizer) specifically so this test needs no second real single-token
// word beyond "hello" (the only phrase this file has verified token IDs
// for) to prove two independent, non-conflicting sources merge into one map.
test("a story phrase-bias entry adds to the profile's own, merging into one request", async () => {
  const body = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ logitBias: { "99999": 5 } })
    ),
    PROMPT,
    OMIT_PLANS[0]!,
    { storySampling: storySampling({ phraseBias: [{ phrase: "hello", weight: 3 }] }) }
  );
  assert.deepEqual(body.logit_bias, {
    "99999": 5,
    "24912": 3,
    "40617": 3,
    "13225": 3,
    "32949": 3
  });
});

// A profile with nothing at all configured in the logit-bias family
// (phraseBias, bannedStrings, and the raw numeric logitBias map all empty)
// must still apply a story-only phraseBias entry. The family's availability
// and wire field are normally read off whichever family member the profile
// configured (server/provider-sampling.ts) — with nothing configured there
// is no such member to read from, so a story-only value needs its own
// availability check, not silent omission.
test("a story phrase-bias entry applies even when the profile has nothing in the logit-bias family configured", async () => {
  const body = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({})
    ),
    PROMPT,
    OMIT_PLANS[0]!,
    { storySampling: storySampling({ phraseBias: [{ phrase: "hello", weight: 3 }] }) }
  );
  assert.deepEqual(body.logit_bias, {
    "24912": 3,
    "40617": 3,
    "13225": 3,
    "32949": 3
  });
});

// A story with no phraseBias/bannedStrings overlay — omitted entirely, the
// shape every non-story call site (title and summary generation) actually
// passes — must serialize byte-identically to the profile-only request
// issue #282 already shipped.
test("a story with no phrase-bias or banned-strings value inherits the profile value unchanged", async () => {
  const withoutStory = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ phraseBias: [{ phrase: "hello", weight: 3 }] })
    ),
    PROMPT,
    OMIT_PLANS[0]!
  );
  const withEmptyStory = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ phraseBias: [{ phrase: "hello", weight: 3 }] })
    ),
    PROMPT,
    OMIT_PLANS[0]!,
    { storySampling: storySampling({}) }
  );
  const expected = { "24912": 3, "40617": 3, "13225": 3, "32949": 3 };
  assert.deepEqual(withoutStory.logit_bias, expected);
  assert.deepEqual(withEmptyStory.logit_bias, expected);
});

// Issue #341 decision 4, the one that matters most: a story entry that
// conflicts with a profile entry is an override, not a shadow. If this
// blocked the way a same-scope conflict does, a vault-wide phrase-bias
// weight plus one story-specific override would refuse every request in
// that story — exactly the defect this decision exists to prevent.
test("a story entry overriding a profile entry does not block, and the story weight ships", async () => {
  const body = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ phraseBias: [{ phrase: "hello", weight: 20 }] })
    ),
    PROMPT,
    OMIT_PLANS[0]!,
    { storySampling: storySampling({ phraseBias: [{ phrase: "hello", weight: -7 }] }) }
  );
  assert.deepEqual(body.logit_bias, {
    "24912": -7,
    "40617": -7,
    "13225": -7,
    "32949": -7
  });
});

// A conflict within one scope — here, two entries the story itself
// configured — keeps today's blocking shadow semantics exactly: the story
// override rule (decision 4) only ever softens a *cross*-scope conflict.
test("a conflict between two entries in the same scope still blocks, even when that scope is the story", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "gpt-4o" },
        "openai",
        sampling({})
      ),
      PROMPT,
      OMIT_PLANS[0]!,
      {
        storySampling: storySampling({
          phraseBias: [
            { phrase: "hello", weight: 5 },
            { phrase: "Hello", weight: 9 }
          ]
        })
      }
    ),
    /Could not use "hello" as configured: "hello" loses its bias on "Hello", " Hello" to this story's phrase bias "Hello"/
  );
});

// Issue #341 decision 6: the capability matrix stays the single owner of
// availability. OpenRouter has no trustworthy tokenizer source (shared/
// sampling-capabilities.ts), so phrase bias is unavailable there regardless
// of scope — a story value must never make it available, including when the
// profile itself has nothing configured (the case that skipped this check
// entirely before the fix: `configured` only ever looked at the profile).
test("a story value on a preset with no phrase-bias support stays unavailable", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(settings("openai-compatible"), "openrouter", sampling({})),
      PROMPT,
      OMIT_PLANS[0]!,
      { storySampling: storySampling({ phraseBias: [{ phrase: "hello", weight: 1 }] }) }
    ),
    /Configured sampling parameter phrase bias is unavailable/
  );
});

// Regression test for issue #341 finding 1: the merge that decided what
// ships was source-major (every phraseBias entry, then every bannedStrings
// entry, then the raw numeric map, regardless of scope) while the
// classification rule assumed scope-major (a story entry only ever loses to
// another story entry). Across sources that assumption was false: a profile
// bannedStrings entry outranked a story phraseBias entry on the wire even
// though decision 4 says the story value must win. "hello" (profile,
// bannedStrings) and "hello" (story, phraseBias) collide on every one of
// "hello"'s four tokens; the story's weight must be what ships, not the
// profile's fixed banned-string minimum.
test("a story phrase-bias entry outranks a colliding profile banned string, and the story weight ships", async () => {
  const body = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({ bannedStrings: ["hello"] })
    ),
    PROMPT,
    OMIT_PLANS[0]!,
    { storySampling: storySampling({ phraseBias: [{ phrase: "hello", weight: 20 }] }) }
  );
  assert.deepEqual(body.logit_bias, {
    "24912": 20,
    "40617": 20,
    "13225": 20,
    "32949": 20
  });
});

// Regression test for issue #341 finding 1, the same defect against the raw
// numeric logitBias map: the old merge applied `logitBias` unconditionally
// last, after every phraseBias and bannedStrings entry of *either* scope, so
// a profile logitBias entry always won even against a story phraseBias entry
// that named the exact same tokens. The profile's numeric pins here collide
// with every one of "hello"'s four tokens; the story's weight must ship.
test("a story phrase-bias entry outranks a colliding profile numeric logitBias entry, and the story weight ships", async () => {
  const body = await buildOpenAiChatRequestBody(
    withSampling(
      { ...settings("openai-compatible"), model: "gpt-4o" },
      "openai",
      sampling({
        logitBias: { "24912": -100, "40617": -100, "13225": -100, "32949": -100 }
      })
    ),
    PROMPT,
    OMIT_PLANS[0]!,
    { storySampling: storySampling({ phraseBias: [{ phrase: "hello", weight: 20 }] }) }
  );
  assert.deepEqual(body.logit_bias, {
    "24912": 20,
    "40617": 20,
    "13225": 20,
    "32949": 20
  });
});

// Regression test for issue #341 finding 1b, the mirror form: two entries in
// the *same* scope (here, profile) genuinely conflict with each other —
// "hello" and "Hello" share two tokens and write different weights — which
// #282 has always blocked. Deciding "shadowed" from whichever entry the
// *overall* map remembers as final owner breaks that guarantee the moment an
// unrelated story entry also touches the same tokens and ends up as that
// overall owner: the profile-vs-profile conflict is still real, but the old
// rule saw only a cross-scope loss to the story entry and called both
// profile entries "overridden", so the request would have shipped the
// story's weight without ever reporting the profile's own internal
// disagreement. The story entry here does not conflict with either profile
// entry in the sense that matters (it is a legitimate cross-scope override);
// the profile's own same-scope conflict must still block regardless of what
// weight the story entry happens to carry.
//
// This asserts the contract over a spread of story weights rather than one
// chosen literal (round 2 review, finding 1): an earlier version of this test
// picked story weight 99 only, which the buggy implementation also blocked —
// because *any* story weight that merely differed from the profile's own 5
// left `conflicts.length > 0` on the old cross-scope gate. That gate read
// `merged`, not `scopeMerged`, so the one weight that actually exercised the
// bug is 5 — the story writing the *same* weight the profile's own losing
// entry already had. There, the cross-scope map's final value coincidentally
// equals `ownWeight`, `conflicts` comes back empty, and the old code returned
// early before ever consulting `views.byScope` — silently dropping the real
// same-scope conflict. The loop below includes that exact value alongside
// ordinary ones, so a future change that reopens the gate on any single
// weight fails here, not just on 5.
test("two profile entries that conflict with each other still block, for any story weight including one equal to the profile's own", async () => {
  for (const storyWeight of [-3, 0, 5, 9, 42, 99]) {
    await assert.rejects(
      () => buildOpenAiChatRequestBody(
        withSampling(
          { ...settings("openai-compatible"), model: "gpt-4o" },
          "openai",
          sampling({
            phraseBias: [
              { phrase: "hello", weight: 5 },
              { phrase: "Hello", weight: 9 }
            ]
          })
        ),
        PROMPT,
        OMIT_PLANS[0]!,
        { storySampling: storySampling({ phraseBias: [{ phrase: "hello", weight: storyWeight }] }) }
      ),
      /Could not use "hello" as configured: "hello" loses its bias on/,
      `story weight ${storyWeight} did not block`
    );
  }
});

// Regression test for issue #341 finding 1b, the form the second review
// found first: two entries in the *story* scope conflict with each other —
// "hello" and "Hello" again — while a profile numeric logitBias entry also
// pins two of the same tokens. The profile entry never conflicts with either
// story entry in the sense that matters (a legitimate cross-scope override
// either way); the story's own same-scope conflict between its two entries
// must still block.
test("two story entries that conflict with each other still block, even alongside an unrelated profile logitBias entry", async () => {
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(
        { ...settings("openai-compatible"), model: "gpt-4o" },
        "openai",
        sampling({
          logitBias: { "24912": -100, "40617": -100, "13225": -100, "32949": -100 }
        })
      ),
      PROMPT,
      OMIT_PLANS[0]!,
      {
        storySampling: storySampling({
          phraseBias: [
            { phrase: "hello", weight: 5 },
            { phrase: "Hello", weight: 9 }
          ]
        })
      }
    ),
    /Could not use "hello" as configured: "hello" loses its bias on/
  );
});

test("Anthropic lowering uses only its exact wire names", async () => {
  const body = await buildAnthropicMessagesRequestBody(
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

test("serializers refuse configured sampling values that the selected route cannot lower", async () => {
  const cases: readonly [string, SamplingSettingsV2][] = [
    ["top k", sampling({ topK: 32 })],
    ["min p", sampling({ minP: 0.05 })],
    ["repeat penalty", sampling({ repeatPenalty: 1.1 })]
  ];
  for (const [field, value] of cases) {
    const settingsValue = withSampling(settings("openai-compatible"), "custom", value);
    await assert.rejects(
      () => buildOpenAiChatRequestBody(settingsValue, PROMPT, OMIT_PLANS[0]!),
      new RegExp(`Configured sampling parameter ${field}`)
    );
  }
  await assert.rejects(
    () => buildOpenAiChatRequestBody(
      withSampling(settings("openai-compatible"), "ollama", sampling({ logitBias: { "1": 1 } })),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter logit bias/
  );
  await assert.rejects(
    () => buildAnthropicMessagesRequestBody(
      withSampling({ ...settings("anthropic"), model: "claude-opus-4-5" }, "anthropic", sampling({ frequencyPenalty: 0.2 })),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter frequency penalty/
  );
  await assert.rejects(
    () => buildAnthropicMessagesRequestBody(
      withSampling({ ...settings("anthropic"), model: "claude-opus-4-5" }, "anthropic", sampling({ seed: 42 })),
      PROMPT,
      OMIT_PLANS[0]!
    ),
    /Configured sampling parameter seed/
  );
});

// Regression test for issue #282 review finding A: raising
// SAMPLING_LOGIT_BIAS_POLICY.maxEntries from 16 to 200 removed the guard
// that used to cover every preset, because the replacement preset-aware
// bound only ran when phraseBias or bannedStrings were configured. A
// KoboldCpp request with 17 plain numeric logitBias entries and empty
// phrase lists — the exact shape that was impossible to build before this
// change — must still be refused when the request body is actually built,
// not just at settings-save time.
test("KoboldCpp's documented 16-entry cap rejects 17 plain numeric logitBias entries in a built request", async () => {
  const koboldSettings = withSampling(
    settings("openai-compatible"),
    "koboldcpp",
    sampling({
      logitBias: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), 1]))
    })
  );
  await assert.rejects(
    () => buildOpenAiChatRequestBody(koboldSettings, PROMPT, OMIT_PLANS[0]!),
    /16-entry limit for preset koboldcpp/
  );

  const withinBudget = withSampling(
    settings("openai-compatible"),
    "koboldcpp",
    sampling({
      logitBias: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [String(index), 1]))
    })
  );
  const body = await buildOpenAiChatRequestBody(withinBudget, PROMPT, OMIT_PLANS[0]!);
  assert.equal(Object.keys(body.logit_bias as Record<string, number>).length, 16);
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
    tokenProbabilities: null,
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
    tokenProbabilities: null,
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

function storySampling(overrides: Partial<StorySamplingBias>): StorySamplingBias {
  return {
    phraseBias: overrides.phraseBias ?? [],
    bannedStrings: overrides.bannedStrings ?? []
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
    tokenProbabilities: null,
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
