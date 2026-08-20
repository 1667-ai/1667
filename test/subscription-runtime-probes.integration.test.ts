import assert from "node:assert/strict";
import test from "node:test";
import { attachProviderRuntime } from "../server/provider-runtime.js";
import { probeContextWindow } from "../server/context-probe.js";
import { discoverProviderModels } from "../server/model-discovery.js";
import { checkModelServer } from "../server/server-check.js";
import { EMPTY_SAMPLING_V2 } from "../shared/settings-v2-types.js";

test("subscription probes use bundled catalogs without an HTTP URL", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("subscription probe attempted HTTP");
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const fixture of [
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
  ]) {
    const settings = attachProviderRuntime({
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
      sampling: EMPTY_SAMPLING_V2
    }, true);

    assert.equal((await checkModelServer(settings)).state, "ready");
    const discovery = await discoverProviderModels(
      settings,
      () => new Date("2026-08-18T00:00:00.000Z")
    );
    assert.equal(discovery.observedAt, "2026-08-18T00:00:00.000Z");
    assert.ok(discovery.models.some((model) => model.remoteId === fixture.model));
    assert.ok(discovery.models.every((model) => model.source === "pi-catalog"));
    assert.equal(await probeContextWindow(settings), null);
  }
});
