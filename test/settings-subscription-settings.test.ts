import assert from "node:assert/strict";
import test from "node:test";
import {
  convertGenerationSettingsV1,
  providerForProtocol
} from "../server/settings-v2-conversion.js";
import { createSettingsRuntimeResolver } from "../server/settings-runtime-resolver.js";
import { parseSettingsDocumentV2 } from "../server/settings-v2-codec.js";
import { settingsViewFromState } from "../server/settings-v2-runtime.js";
import { createSubscriptionRuntime } from "../server/subscription-runtime.js";
import { supportsAssistantPrefill } from "../shared/continuation-plan.js";
import { decodeSettingsViewResponse } from "../shared/settings-response-decoder.js";
import { INITIAL_SETTINGS_STATE_V2 } from "../server/settings-v2-default.js";
import type {
  ModelConnectionV2,
  SettingsDocumentV2
} from "../shared/settings-v2-types.js";

test("subscription presets keep their fixed connection shape and runtime route", () => {
  const subscription = createSubscriptionRuntime(process.cwd());
  const runtimeResolver = createSettingsRuntimeResolver({
    environment: process.env,
    subscription
  });
  const base = convertGenerationSettingsV1({
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "test-model",
    apiKeyEnv: "OPENAI_API_KEY",
    temperature: 0.7,
    maxTokens: 2_048,
    systemPrompt: "Continue.",
    contextWindow: 32_768
  });
  const chatgpt = subscriptionDocument(base, "chatgpt-plan", "openai-codex-responses");
  const claude = subscriptionDocument(base, "claude-plan", "anthropic-subscription-messages");

  for (const [document, provider, protocol] of [
    [chatgpt, "openai-compatible", "openai-codex-responses"],
    [claude, "anthropic", "anthropic-subscription-messages"]
  ] as const) {
    const connection = document.connections["migrated:connection"]!;
    assert.equal(connection.baseUrl, null);
    assert.deepEqual(connection.auth, { type: "none" });
    assert.deepEqual(connection.headers, []);
    assert.equal(providerForProtocol(connection.protocol), provider);
    const runtime = runtimeResolver.resolve({ document });
    assert.equal(runtime.settings.provider, provider);
    assert.equal(runtime.settings.baseUrl, "");
    assert.equal(runtime.settings.apiKeyEnv, null);
    assert.equal(runtime.settings.protocol, protocol);
    assert.equal(runtime.providerRuntime.protocol, protocol);
    const decoded = decodeSettingsViewResponse(
      JSON.parse(JSON.stringify(settingsViewFromState({
        ...INITIAL_SETTINGS_STATE_V2,
        documents: { "1": document }
      }))),
      parseSettingsDocumentV2
    );
    assert.equal(decoded.effectiveProse.protocol, protocol);
    assert.equal(supportsAssistantPrefill(decoded.effectiveProse), false);
  }
});

test("subscription protocols reject pair and shape mutations", () => {
  const base = convertGenerationSettingsV1({
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "test-model",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 1_024,
    systemPrompt: "Continue.",
    contextWindow: null
  });
  const plan = subscriptionDocument(base, "chatgpt-plan", "openai-codex-responses");
  const mutate = (connection: Partial<ModelConnectionV2>): SettingsDocumentV2 => ({
    ...plan,
    connections: {
      ...plan.connections,
      "migrated:connection": {
        ...plan.connections["migrated:connection"]!,
        ...connection
      }
    }
  });

  assert.throws(() => parseSettingsDocumentV2(mutate({
    preset: "custom"
  })));
  assert.throws(() => parseSettingsDocumentV2(mutate({
    protocol: "anthropic-subscription-messages"
  })));
  assert.throws(() => parseSettingsDocumentV2(mutate({
    baseUrl: "https://example.com"
  })));
  assert.throws(() => parseSettingsDocumentV2(mutate({
    auth: { type: "bearer-env", env: "OPENAI_API_KEY" }
  })));
  assert.throws(() => parseSettingsDocumentV2(mutate({
    headers: [{ name: "x-test", value: { type: "env", env: "PATH" } }]
  })));
  assert.throws(() => parseSettingsDocumentV2(mutate({
    allowInsecureHttp: true
  })));
  assert.throws(() => parseSettingsDocumentV2(mutate({
    textPromptFormat: "raw"
  })));
});

function subscriptionDocument(
  document: SettingsDocumentV2,
  preset: "chatgpt-plan" | "claude-plan",
  protocol: "openai-codex-responses" | "anthropic-subscription-messages"
): SettingsDocumentV2 {
  const connection = document.connections["migrated:connection"]!;
  return parseSettingsDocumentV2({
    ...document,
    connections: {
      ...document.connections,
      "migrated:connection": {
        ...connection,
        name: preset === "chatgpt-plan" ? "ChatGPT plan" : "Claude plan",
        preset,
        protocol,
        baseUrl: null,
        auth: { type: "none" },
        headers: []
      }
    }
  });
}
