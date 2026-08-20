import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { probeContextWindow } from "../server/context-probe.js";
import { discoverProviderModels } from "../server/model-discovery.js";
import { checkModelServer } from "../server/server-check.js";
import { subscriptionProviderForProtocol } from "../server/subscription-protocol.js";
import {
  createSubscriptionRuntime,
  type SubscriptionRuntimeDependencies
} from "../server/subscription-runtime.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";
import { MAX_DISCOVERED_MODELS } from "../shared/settings-scalar-policy.js";

const PLAN_FIXTURES = [
  {
    provider: "openai-compatible" as const,
    preset: "chatgpt-plan" as const,
    protocol: "openai-codex-responses" as const,
    model: "gpt-5.4"
  },
  {
    provider: "anthropic" as const,
    preset: "claude-plan" as const,
    protocol: "anthropic-subscription-messages" as const,
    model: "claude-sonnet-4-6"
  }
] as const;

test("subscription probes use bundled catalogs without an HTTP URL", async (t) => {
  const secretsDir = await mkdtemp(path.join(tmpdir(), "1667-model-catalog-"));
  t.after(async () => { await rm(secretsDir, { recursive: true, force: true }); });
  const subscription = createSubscriptionRuntime(secretsDir);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("subscription probe attempted HTTP");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const fixture of PLAN_FIXTURES) {
    const settings = subscriptionProbeSettings(fixture, subscription);

    assert.equal((await checkModelServer(settings)).state, "ready");
    const discovery = await discoverProviderModels(
      settings,
      () => new Date("2026-08-18T00:00:00.000Z")
    );
    assert.equal(discovery.observedAt, "2026-08-18T00:00:00.000Z");
    assert.deepEqual(
      discovery.models.map((model) => model.remoteId),
      subscription.models
        .getModels(subscriptionProviderForProtocol(fixture.protocol))
        .slice(0, MAX_DISCOVERED_MODELS)
        .map((model) => model.id)
    );
    assert.ok(discovery.models.some((model) => model.remoteId === fixture.model));
    assert.ok(discovery.models.every((model) => model.source === "pi-catalog"));
    assert.equal(await probeContextWindow(settings), null);
  }
});

test("subscription catalogs use the durable discovery sanitizer", async () => {
  const catalog = [
    {
      id: " invalid",
      name: "Invalid",
      contextWindow: 1,
      maxTokens: 1
    },
    ...Array.from({ length: MAX_DISCOVERED_MODELS }, (_, index) => ({
      id: `valid-${index}`,
      name: index === 0 ? "e\u0301" : `Valid ${index}`,
      contextWindow: index === 0 ? 0 : 32_768,
      maxTokens: index === 0 ? Number.MAX_SAFE_INTEGER : 4_096
    }))
  ];
  const subscription = {
    credentials: {} as SubscriptionRuntimeDependencies["credentials"],
    models: { getModels: () => catalog } as unknown as Models
  };

  const discovery = await discoverProviderModels(
    subscriptionProbeSettings(PLAN_FIXTURES[0], subscription)
  );

  assert.equal(discovery.models.length, MAX_DISCOVERED_MODELS);
  assert.deepEqual(discovery.models[0], {
    remoteId: "valid-0",
    name: "valid-0",
    contextWindow: null,
    maxOutputTokens: null,
    source: "pi-catalog"
  });
  assert.equal(
    discovery.models.at(-1)?.remoteId,
    `valid-${MAX_DISCOVERED_MODELS - 1}`
  );
});

function subscriptionProbeSettings(
  fixture: (typeof PLAN_FIXTURES)[number],
  subscription: SubscriptionRuntimeDependencies
) {
  return attachProviderRuntime({
    provider: fixture.provider,
    baseUrl: "",
    model: fixture.model,
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "",
    contextWindow: null
  }, {
    preset: fixture.preset,
    protocol: fixture.protocol,
    auth: { type: "none" },
    headers: [],
    timeouts: { responseHeaderMs: 1_000, firstTokenMs: 1_000, idleMs: 1_000, totalMs: 2_000 },
    allowInsecureHttp: false,
    effort: "default",
    tokenProbabilities: null,
    capabilities: {
      temperature: "supported",
      assistantPrefill: "unknown",
      reasoningEffort: "unknown",
      promptCaching: "unknown"
    },
    sampling: EMPTY_SAMPLING_V2,
    subscription
  }, true);
}
