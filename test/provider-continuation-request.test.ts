import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAiChatRequestBody } from "../server/provider-request-body.js";
import {
  attachProviderRuntime,
  providerRuntimeFor
} from "../server/provider-runtime.js";
import type { PromptPlan } from "../shared/prompt-plan.js";
import type { GenerationSettings } from "../shared/types.js";

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
      role: "user",
      blocks: [{
        stability: "stable",
        kind: "source",
        text: "Rain crossed the window.",
        boundaryAfter: "none"
      }]
    },
    {
      role: "assistant",
      blocks: [{
        stability: "volatile",
        kind: "boundary",
        text: "The lantern dimmed",
        boundaryAfter: "none"
      }]
    }
  ]
};

const OMIT_CACHE = { kind: "omit", reason: "policy-off" } as const;

test("llama.cpp Chat Completions keeps a trailing assistant message open", async () => {
  const body = await buildOpenAiChatRequestBody(
    { ...settings(), baseUrl: "http://127.0.0.1:8080/v1" },
    PROMPT,
    OMIT_CACHE
  );
  assert.equal(body.add_generation_prompt, false);
  assert.equal(body.continue_final_message, true);
});

test("a non-llama.cpp route does not receive llama.cpp-only fields", async () => {
  const body = await buildOpenAiChatRequestBody(settings(), PROMPT, OMIT_CACHE);
  assert.equal("add_generation_prompt" in body, false);
  assert.equal("continue_final_message" in body, false);
});

test("an explicitly supported custom route does not receive llama.cpp-only fields", async () => {
  const base = settings();
  const runtime = providerRuntimeFor(base);
  const supported = attachProviderRuntime(base, {
    ...runtime,
    capabilities: { ...runtime.capabilities, assistantPrefill: "supported" }
  }, true);
  const body = await buildOpenAiChatRequestBody(supported, PROMPT, OMIT_CACHE);
  assert.equal("add_generation_prompt" in body, false);
  assert.equal("continue_final_message" in body, false);
});

function settings(): GenerationSettings {
  return {
    provider: "openai-compatible",
    baseUrl: "https://provider.example/v1",
    model: "model-fixture",
    apiKeyEnv: null,
    temperature: 0.25,
    maxTokens: 321,
    systemPrompt: "Write with restraint.",
    contextWindow: null
  };
}
