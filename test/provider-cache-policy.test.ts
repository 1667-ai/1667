import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_PROMPT_CACHE_CONTEXT,
  lowerPromptCache,
  PromptCachePolicyError,
  PromptCacheRuntime,
  promptCacheScope,
  type PromptCacheAdapter,
  type PromptCacheContext
} from "../server/provider-cache-policy.js";
import { parseSettingsDocumentV2 } from "../server/settings-v2-codec.js";
import {
  convertGenerationSettingsV1,
  effectiveGenerationSettings,
  effectivePromptCacheContext
} from "../server/settings-v2-conversion.js";
import { promptCachePolicyPresentation } from "../shared/prompt-cache-capabilities.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import type {
  FeatureSupportV2,
  PromptCachePolicyV2,
  SettingsDocumentV2,
  SettingsPresetV2
} from "../shared/settings-v2-types.js";
import type { GenerationSettings } from "../shared/types.js";

test("cache scope has fixed privacy-preserving story and operation vectors", () => {
  assert.equal(
    promptCacheScope("story-123", "continue"),
    "st:v1:f8c40a249c7c4a38fa058d88bd45b514b28704f6b785e80c54683a943c8d7fc9:continue"
  );
  assert.equal(
    promptCacheScope("Δ-story/with spaces", "summary"),
    "st:v1:a106ebebd5c1e670eae4a69fe32fea877a0e9bd1d06ea37f1c4a2b6db7585d5b:summary"
  );
  assert.notEqual(promptCacheScope("story-123", "continue"), promptCacheScope("story-124", "continue"));
  assert.equal(
    promptCacheScope("story-123", "rewrite").split(":").slice(0, 3).join(":"),
    promptCacheScope("story-123", "title").split(":").slice(0, 3).join(":")
  );
  assert.throws(() => promptCacheScope("", "continue"), /story ID/);
});

test("selected v2 route projects policy, support, and exact adapter identity", () => {
  const openAi = cacheDocument("openai-compatible", "openai", "supported", "off");
  assert.deepEqual(effectivePromptCacheContext(openAi), {
    source: "settings-v2",
    policy: "off",
    support: "supported",
    protocol: "openai-chat-completions",
    preset: "openai",
    remoteModelId: "model-fixture",
    adapter: "openai-official"
  });

  const sameUrlCustom = withPreset(openAi, "custom");
  assert.equal(
    effectivePromptCacheContext(sameUrlCustom).adapter,
    "compatible",
    "a URL alone never promotes a custom endpoint to an official adapter"
  );

  const anthropic = cacheDocument("anthropic", "anthropic", "supported", "off");
  assert.equal(effectivePromptCacheContext(anthropic).adapter, "anthropic-official");
  assert.equal(
    effectivePromptCacheContext(withBaseUrl(anthropic, "https://gateway.example/v1")).adapter,
    "compatible",
    "an official preset label cannot promote a custom Anthropic host"
  );
  assert.deepEqual(effectivePromptCacheContext(INITIAL_SETTINGS_DOCUMENT_V2), {
    source: "settings-v2",
    policy: "off",
    support: "unsupported",
    protocol: "dry-run",
    preset: "dry-run",
    remoteModelId: "dry-run",
    adapter: "dry-run"
  });
});

test("capability lowering is conservative and never silently downgrades opt-in policy", () => {
  assert.deepEqual(lowerPromptCache(LEGACY_PROMPT_CACHE_CONTEXT), {
    kind: "omit",
    reason: "legacy-v1"
  });
  assert.deepEqual(lowerPromptCache(context("dry-run", "unsupported", "off")), {
    kind: "omit",
    reason: "dry-run"
  });
  assert.deepEqual(lowerPromptCache(context("openai-official", "unknown", "off")), {
    kind: "omit",
    reason: "policy-off"
  });
  assert.deepEqual(lowerPromptCache(context("dry-run", "unsupported", "auto")), {
    kind: "blocked",
    reason: "unsupported"
  });
  assert.deepEqual(lowerPromptCache(context("compatible", "supported", "auto")), {
    kind: "blocked",
    reason: "compatible-endpoint"
  });
  assert.deepEqual(lowerPromptCache(context("openai-official", "unsupported", "long")), {
    kind: "blocked",
    reason: "unsupported"
  });
  assert.deepEqual(lowerPromptCache(context("anthropic-official", "unknown", "auto")), {
    kind: "blocked",
    reason: "unknown-model"
  });
  assert.deepEqual(
    lowerPromptCache(context(
      "anthropic-official",
      "supported",
      "long",
      "claude-sonnet-4-6"
    )),
    { kind: "anthropic-explicit", ttl: "1h" }
  );
  assert.deepEqual(
    lowerPromptCache(context("openai-official", "unknown", "auto", "gpt-5.6")),
    {
      kind: "openai-explicit",
      minimumTokens: 1_024,
      tokenizer: "o200k_base",
      maximumBreakpoints: 4
    },
    "exact built-in models may supply capability data when discovery is unknown"
  );
  assert.deepEqual(
    lowerPromptCache(context("openai-official", "supported", "off", "gpt-5.6")),
    { kind: "openai-explicit-off" }
  );
  assert.deepEqual(
    lowerPromptCache(context("openai-official", "supported", "auto", "gpt-5.4")),
    { kind: "openai-automatic", retention: null }
  );
  assert.deepEqual(
    lowerPromptCache(context("openai-official", "supported", "long", "gpt-5.4")),
    { kind: "openai-automatic", retention: "24h" }
  );
  assert.deepEqual(
    lowerPromptCache(context("openai-official", "supported", "long", "gpt-5.6")),
    { kind: "blocked", reason: "long-unsupported" }
  );
  for (const remoteModelId of [
    "gpt-5.6-preview",
    "gpt-5.60",
    "claude-sonnet-5-preview"
  ]) {
    const adapter = remoteModelId.startsWith("claude")
      ? "anthropic-official"
      : "openai-official";
    assert.deepEqual(
      lowerPromptCache(context(adapter, "supported", "auto", remoteModelId)),
      { kind: "blocked", reason: "unknown-model" },
      `${remoteModelId} must not gain a contract through family-prefix matching`
    );
  }
  assert.deepEqual(
    lowerPromptCache(context("openai-official", "unsupported", "auto", "gpt-5.4")),
    { kind: "blocked", reason: "unsupported" },
    "an explicit unsupported declaration wins over the built-in catalog"
  );
});

test("unavailable cache policies use provider and model language", () => {
  const provider = promptCachePolicyPresentation(
    context("compatible", "supported", "auto"),
    "auto"
  );
  assert.equal(provider.available, false);
  if (!provider.available) {
    assert.equal(provider.unavailableReason, "Prompt caching is not supported by this provider.");
    assert.equal(provider.unavailableReasonCompact, "Not supported.");
  }

  const model = promptCachePolicyPresentation(
    context("anthropic-official", "unknown", "auto", "unknown-model"),
    "auto"
  );
  assert.equal(model.available, false);
  if (!model.available) {
    assert.equal(model.unavailableReason, "Prompt-cache support is unknown for this model.");
    assert.equal(model.unavailableReasonCompact, "Support unknown.");
  }
});

test("runtime plans cache only stable boundaries and commit rolling state after dispatch", () => {
  const prompt = {
    operation: "continue" as const,
    turns: [{
      role: "system" as const,
      blocks: [
        {
          stability: "stable" as const,
          kind: "author-brief" as const,
          text: "brief",
          boundaryAfter: "candidate" as const
        },
        {
          stability: "stable" as const,
          kind: "source" as const,
          text: "story",
          boundaryAfter: "candidate" as const
        },
        {
          stability: "volatile" as const,
          kind: "request" as const,
          text: "continue",
          boundaryAfter: "none" as const
        }
      ]
    }]
  };
  const runtime = new PromptCacheRuntime({ countOpenAiTokens: () => 1_024 });
  assert.equal(
    Object.prototype.hasOwnProperty.call(runtime, "registry"),
    false,
    "qualified rolling state is not externally mutable"
  );
  const cacheContext = context("openai-official", "supported", "auto", "gpt-5.6");
  const first = runtime.prepare(cacheContext, "scope", prompt);
  assert.deepEqual(first.wire, {
    kind: "openai-explicit",
    key: "scope",
    breakpoints: [{ turn: 0, block: 1 }]
  });
  assert.equal(runtime.registrySize, 0, "planning alone must not advance rolling state");
  first.commit();
  first.commit();
  assert.equal(runtime.registrySize, 1, "dispatch commit is idempotent");

  const second = runtime.prepare(cacheContext, "scope", {
    ...prompt,
    turns: [{
      ...prompt.turns[0]!,
      blocks: [
        ...prompt.turns[0]!.blocks.slice(0, 2),
        {
          stability: "stable" as const,
          kind: "source" as const,
          text: "new story",
          boundaryAfter: "candidate" as const
        },
        prompt.turns[0]!.blocks[2]!
      ]
    }]
  });
  assert.deepEqual(second.wire, {
    kind: "openai-explicit",
    key: "scope",
    breakpoints: [
      { turn: 0, block: 1 },
      { turn: 0, block: 2 }
    ]
  });
});

test("runtime admission accepts exact contracts and rejects unsupported policy precisely", () => {
  assert.equal(
    effectiveGenerationSettings(
      cacheDocument("openai-compatible", "openai", "supported", "auto", "gpt-5.6")
    ).model,
    "gpt-5.6"
  );
  assert.equal(
    effectiveGenerationSettings(
      cacheDocument("anthropic", "anthropic", "supported", "long", "claude-sonnet-4-6")
    ).model,
    "claude-sonnet-4-6"
  );
  assert.throws(
    () => effectiveGenerationSettings(
      cacheDocument("openai-compatible", "openai", "supported", "long", "gpt-5.6")
    ),
    /Long prompt-cache retention is unavailable/
  );
  assert.throws(
    () => effectiveGenerationSettings(
      cacheDocument("openai-compatible", "custom", "supported", "auto", "gpt-5.4")
    ),
    /Prompt caching is not supported by the selected provider/
  );
  assert.throws(
    () => new PromptCacheRuntime().prepare(
      context("openai-official", "supported", "auto", "unknown-model"),
      "scope",
      { operation: "title", turns: [] }
    ),
    PromptCachePolicyError
  );
});

function context(
  adapter: PromptCacheAdapter,
  support: FeatureSupportV2,
  policy: PromptCachePolicyV2,
  remoteModelId = "model-fixture"
): PromptCacheContext {
  return {
    source: "settings-v2",
    policy,
    support,
    protocol: adapter === "anthropic-official"
      ? "anthropic-messages"
      : adapter === "dry-run"
        ? "dry-run"
        : "openai-chat-completions",
    preset: adapter === "anthropic-official"
      ? "anthropic"
      : adapter === "openai-official"
        ? "openai"
        : adapter === "dry-run"
          ? "dry-run"
          : "custom",
    remoteModelId,
    adapter
  };
}

function cacheDocument(
  provider: Exclude<GenerationSettings["provider"], "dry-run">,
  preset: SettingsPresetV2,
  support: FeatureSupportV2,
  policy: PromptCachePolicyV2,
  remoteModelId = "model-fixture"
): SettingsDocumentV2 {
  const base = convertGenerationSettingsV1({
    provider,
    baseUrl: provider === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com/v1",
    model: remoteModelId,
    apiKeyEnv: provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY",
    temperature: 0.25,
    maxTokens: 321,
    systemPrompt: "Write with restraint.",
    contextWindow: null
  });
  const connection = base.connections["migrated:connection"]!;
  const model = base.models["migrated:model"]!;
  const profile = base.profiles.default!;
  return parseSettingsDocumentV2({
    ...base,
    connections: {
      "migrated:connection": { ...connection, preset }
    },
    models: {
      "migrated:model": {
        ...model,
        capabilities: { ...model.capabilities, promptCaching: support }
      }
    },
    profiles: {
      default: { ...profile, cachePolicy: policy }
    }
  });
}

function withPreset(
  document: SettingsDocumentV2,
  preset: SettingsPresetV2
): SettingsDocumentV2 {
  const connection = document.connections["migrated:connection"]!;
  return parseSettingsDocumentV2({
    ...document,
    connections: {
      "migrated:connection": { ...connection, preset }
    }
  });
}

function withBaseUrl(
  document: SettingsDocumentV2,
  baseUrl: string
): SettingsDocumentV2 {
  const connection = document.connections["migrated:connection"]!;
  return parseSettingsDocumentV2({
    ...document,
    connections: {
      "migrated:connection": { ...connection, baseUrl }
    }
  });
}
