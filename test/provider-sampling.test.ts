import assert from "node:assert/strict";
import test from "node:test";
import { applySamplingFields } from "../server/provider-sampling.js";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

test("sampling lowering does not partially mutate a body on resolution failure", () => {
  const sampling = {
    ...EMPTY_SAMPLING_V2,
    topP: 0.9,
    topK: 32
  };
  const settings = attachProviderRuntime(baseSettings(), {
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
    sampling,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    }
  });
  const body: Record<string, unknown> = {
    marker: "keep",
    top_p: "original"
  };
  const before = { ...body };

  assert.throws(
    () => applySamplingFields(body, settings, "openai-chat-completions"),
    /Configured sampling parameter top_k/u
  );
  assert.deepEqual(body, before);
});

function baseSettings(): GenerationSettings {
  return {
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "fixture-model",
    apiKeyEnv: null,
    temperature: 0.25,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };
}
