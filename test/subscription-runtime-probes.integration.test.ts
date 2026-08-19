import assert from "node:assert/strict";
import test from "node:test";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { probeContextWindow } from "../server/context-probe.js";
import { discoverProviderModels } from "../server/model-discovery.js";
import { checkModelServer } from "../server/server-check.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";

test("subscription probes use the fixed runtime without an HTTP URL", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("subscription probe attempted HTTP");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const settings = attachProviderRuntime({
    provider: "anthropic",
    baseUrl: "",
    model: "fixture-model",
    apiKeyEnv: null,
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "",
    contextWindow: null
  }, {
    preset: "claude-plan",
    protocol: "anthropic-subscription-messages",
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
    sampling: EMPTY_SAMPLING_V2
  }, true);

  assert.equal((await checkModelServer(settings)).state, "ready");
  assert.deepEqual(
    await discoverProviderModels(settings, () => new Date("2026-08-18T00:00:00.000Z")),
    { observedAt: "2026-08-18T00:00:00.000Z", models: [] }
  );
  assert.equal(await probeContextWindow(settings), null);
});
