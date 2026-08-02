import assert from "node:assert/strict";
import test from "node:test";
import {
  attachProviderRuntime,
  providerRuntimeFromV2,
  resolveProviderHeaders
} from "../server/provider-runtime.js";
import {
  EMPTY_SAMPLING_V2,
  type ModelCapabilitiesV2,
  type ModelConnectionV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

const CAPABILITIES: ModelCapabilitiesV2 = {
  temperature: "supported",
  assistantPrefill: "unknown",
  reasoningEffort: "unknown",
  promptCaching: "unknown"
};

test("v2 runtime keeps legacy credential positions before explicit sampling", () => {
  const connection: ModelConnectionV2 = {
    name: "Compatibility fixture",
    preset: "custom",
    protocol: "openai-chat-completions",
    baseUrl: "https://models.example/v1",
    auth: { type: "bearer-stored", secretId: "compat-secret" },
    headers: [{
      name: "x-tenant-token",
      value: { type: "env", env: "AI_1667_COMPAT_HEADER" }
    }],
    timeouts: {
      responseHeaderMs: 1_000,
      firstTokenMs: 1_000,
      idleMs: 1_000,
      totalMs: 5_000
    }
  };
  const sampling = {
    ...EMPTY_SAMPLING_V2,
    topP: 0.9,
    stop: ["END"],
    logitBias: { "2": -1 }
  } as const;
  const runtime = providerRuntimeFromV2(
    connection,
    "default",
    CAPABILITIES,
    { AI_1667_COMPAT_HEADER: "environment-secret" },
    new Map([["compat-secret", "stored-secret"]]),
    sampling
  );

  assert.deepEqual(runtime.sampling, sampling);
  assert.deepEqual(
    resolveProviderHeaders(
      attachProviderRuntime(baseSettings(), runtime),
      {}
    ),
    {
      headers: {
        authorization: "Bearer stored-secret",
        "x-tenant-token": "environment-secret"
      },
      secrets: ["stored-secret", "environment-secret"]
    }
  );
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
