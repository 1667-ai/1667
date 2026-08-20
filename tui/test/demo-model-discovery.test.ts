import { expect, test } from "bun:test";
import type { SettingsDocumentV2 } from "../../shared/settings-v2-types.js";
import { demoAppSource, DEMO_SETTINGS_DOCUMENT } from "../src/demo.js";
import {
  discoverDemoModels,
  type DemoSubscriptionCatalogs
} from "../src/demo-model-discovery.js";

test("demo discovery resolves one non-default route for provider and source", async () => {
  const document: SettingsDocumentV2 = {
    ...DEMO_SETTINGS_DOCUMENT,
    connections: {
      ...DEMO_SETTINGS_DOCUMENT.connections,
      claude: {
        name: "Claude plan",
        preset: "claude-plan",
        protocol: "anthropic-subscription-messages",
        baseUrl: null,
        auth: { type: "none" },
        headers: [],
        timeouts: {
          responseHeaderMs: 120_000,
          firstTokenMs: 120_000,
          idleMs: 120_000,
          totalMs: 1_800_000
        }
      }
    },
    models: {
      ...DEMO_SETTINGS_DOCUMENT.models,
      claude: {
        connectionId: "claude",
        remoteId: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        discovered: { contextWindow: 1_000_000 },
        overrides: {},
        capabilities: {
          temperature: "supported",
          assistantPrefill: "unknown",
          reasoningEffort: "unknown",
          promptCaching: "unknown"
        }
      }
    },
    profiles: {
      ...DEMO_SETTINGS_DOCUMENT.profiles,
      utility: {
        name: "Utility",
        modelId: "claude",
        temperature: 0.7,
        maxOutputTokens: 2_048,
        effort: "default",
        cachePolicy: "off"
      }
    },
    routing: { ...DEMO_SETTINGS_DOCUMENT.routing, utility: "utility" }
  };

  const discovery = await demoAppSource().api.discoverModels({
    kind: "settings-document",
    document,
    purpose: "utility"
  });

  expect(discovery.models.map((model) => model.remoteId))
    .toContain("claude-sonnet-4-6");
  expect(discovery.models.every((model) => model.source === "pi-catalog"))
    .toBeTrue();
});

test("demo discovery keeps plan protocols on direct probe targets", async () => {
  const subscriptionCatalogs: DemoSubscriptionCatalogs = {
    "openai-codex-responses": [catalogModel("gpt-fixture")],
    "anthropic-subscription-messages": [catalogModel("claude-fixture")]
  };
  const cases = [
    {
      provider: "openai-compatible" as const,
      protocol: "openai-codex-responses" as const,
      expectedModels: ["gpt-fixture"]
    },
    {
      provider: "anthropic" as const,
      protocol: "anthropic-subscription-messages" as const,
      expectedModels: ["claude-fixture"]
    }
  ];

  for (const fixture of cases) {
    const discovery = discoverDemoModels({
      provider: fixture.provider,
      protocol: fixture.protocol,
      baseUrl: "",
      model: "",
      apiKeyEnv: null,
      temperature: 0.7,
      maxTokens: 2_048,
      systemPrompt: "Write plain prose.",
      contextWindow: null
    }, subscriptionCatalogs);

    expect(discovery.models.map((model) => model.remoteId))
      .toEqual(fixture.expectedModels);
    expect(discovery.models.every((model) => model.source === "pi-catalog"))
      .toBeTrue();
  }
});

function catalogModel(id: string) {
  return {
    id,
    name: id,
    contextWindow: 32_768,
    maxTokens: 4_096
  };
}
