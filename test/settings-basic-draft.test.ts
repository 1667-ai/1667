import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBasicModelDiscovery,
  applyBasicSettingsDraft,
  basicSettingsForDisplay,
  basicSettingsFromDocument
} from "../shared/settings-basic-draft.js";
import { applySamplingSettings } from "../shared/sampling-capabilities.js";
import {
  attachProviderRuntime,
  providerRuntimeFromV2,
  resolveProviderHeaders
} from "../server/provider-runtime.js";
import {
  EMPTY_SAMPLING_V2,
  type SamplingSettingsV2,
  type SettingsDocumentV2
} from "../shared/settings-v2-types.js";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../server/settings-v2-default.js";
import { validateSettingsDocumentV2 } from "../server/settings-v2-validation.js";

test("discovery metadata stays separate from manual context overrides", () => {
  const selected = applyBasicSettingsDraft(DOCUMENT, {
    ...basicSettingsFromDocument(DOCUMENT),
    model: "discovered-model",
    contextWindow: 32_768
  });
  const discovery = {
    observedAt: "2026-07-24T00:00:00.000Z",
    models: [{
      remoteId: "discovered-model",
      name: "Discovered model",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      capabilities: {
        temperature: "unknown" as const,
        reasoningEffort: "unknown" as const
      },
      source: "openai-models" as const
    }]
  };
  const exact = applyBasicModelDiscovery(selected, discovery, 32_768);
  assert.deepEqual(exact.models.active?.discovered, {
    contextWindow: 32_768,
    maxOutputTokens: 4_096
  });
  assert.equal(exact.models.active?.overrides.contextWindow, undefined);

  const overridden = applyBasicModelDiscovery(selected, discovery, 16_384);
  assert.equal(overridden.models.active?.discovered.contextWindow, 32_768);
  assert.equal(overridden.models.active?.overrides.contextWindow, 16_384);
});

const DOCUMENT: SettingsDocumentV2 = {
  schemaVersion: 2,
  connections: {
    active: {
      name: "Advanced",
      preset: "custom",
      protocol: "openai-chat-completions",
      baseUrl: "https://old.example/v1",
      auth: { type: "bearer-env", env: "OLD_KEY" },
      headers: [{ name: "x-tenant", value: { type: "env", env: "TENANT" } }],
      timeouts: {
        responseHeaderMs: 11_000,
        firstTokenMs: 12_000,
        idleMs: 13_000,
        totalMs: 14_000
      }
    },
    untouched: {
      name: "Untouched",
      preset: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      auth: { type: "header-env", name: "x-api-key", env: "ANTHROPIC_API_KEY" },
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
    active: {
      connectionId: "active",
      remoteId: "old-model",
      name: "Old model",
      discovered: { contextWindow: 64_000, maxOutputTokens: 8_192 },
      overrides: { maxOutputTokens: 4_096 },
      capabilities: {
        temperature: "supported",
        assistantPrefill: "supported",
        reasoningEffort: "unsupported",
        promptCaching: "supported"
      }
    },
    untouched: {
      connectionId: "untouched",
      remoteId: "claude",
      name: "Untouched model",
      discovered: {},
      overrides: {},
      capabilities: {
        temperature: "supported",
        assistantPrefill: "supported",
        reasoningEffort: "unknown",
        promptCaching: "unknown"
      }
    }
  },
  profiles: {
    default: {
      name: "Default",
      modelId: "active",
      temperature: 0.7,
      maxOutputTokens: 2_048,
      effort: "high",
      cachePolicy: "long"
    },
    utility: {
      name: "Utility",
      modelId: "untouched",
      temperature: null,
      maxOutputTokens: 512,
      effort: "default",
      cachePolicy: "off"
    }
  },
  routing: { default: "default", utility: "utility" },
  writing: { defaultAuthorBrief: "Old brief" }
};

test("initial and advanced documents survive an unchanged basic round-trip exactly", () => {
  for (const document of [INITIAL_SETTINGS_DOCUMENT_V2, DOCUMENT]) {
    assert.equal(
      applyBasicSettingsDraft(document, basicSettingsFromDocument(document)),
      document
    );
  }
});

test("sampling edits only the default profile and preserve route-owned settings", () => {
  const sampling: SamplingSettingsV2 = {
    topP: 0.9,
    topK: null,
    minP: null,
    frequencyPenalty: 0.2,
    presencePenalty: null,
    repeatPenalty: null,
    seed: null,
    stop: ["END"],
    logitBias: { "15043": 1 }
  };
  const updated = applySamplingSettings(DOCUMENT, sampling);
  assert.deepEqual(updated.profiles.default?.sampling, sampling);
  assert.equal(updated.profiles.default?.effort, DOCUMENT.profiles.default?.effort);
  assert.equal(updated.profiles.default?.cachePolicy, DOCUMENT.profiles.default?.cachePolicy);
  assert.deepEqual(updated.profiles.utility, DOCUMENT.profiles.utility);
  assert.deepEqual(updated.routing, DOCUMENT.routing);
  assert.deepEqual(updated.connections, DOCUMENT.connections);
  assert.deepEqual(updated.models, DOCUMENT.models);

  const cleared = applySamplingSettings(updated, EMPTY_SAMPLING_V2);
  assert.equal(Object.hasOwn(cleared.profiles.default!, "sampling"), false);
});

test("canonical model whitespace is an exact no-op that preserves hidden metadata", () => {
  const projected = basicSettingsFromDocument(DOCUMENT);
  const result = applyBasicSettingsDraft(DOCUMENT, {
    ...projected,
    model: `  ${projected.model}  `
  });

  assert.equal(result, DOCUMENT);
  assert.equal(result.models.active, DOCUMENT.models.active);
});

test("an unrelated edit preserves a whitespace-bearing persisted model identity", () => {
  const document = validateSettingsDocumentV2({
    ...DOCUMENT,
    models: {
      ...DOCUMENT.models,
      active: {
        ...DOCUMENT.models.active!,
        remoteId: "  old-model  "
      }
    },
    profiles: {
      ...DOCUMENT.profiles,
      default: {
        ...DOCUMENT.profiles.default!,
        effort: "default"
      }
    }
  });
  const result = applyBasicSettingsDraft(document, {
    ...basicSettingsFromDocument(document),
    temperature: 0.25
  });

  assert.deepEqual(result.models.active, document.models.active);
  assert.equal(result.models.active?.remoteId, "  old-model  ");
  assert.equal(result.profiles.default?.temperature, 0.25);
});

test("the display-equivalent dry-run remote ID is an exact no-op", () => {
  const projected = basicSettingsFromDocument(INITIAL_SETTINGS_DOCUMENT_V2);
  const result = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    ...projected,
    model: "  dry-run  "
  });

  assert.equal(result, INITIAL_SETTINGS_DOCUMENT_V2);
});

test("a dry-run-only credential draft difference is an exact no-op", () => {
  const projected = basicSettingsFromDocument(INITIAL_SETTINGS_DOCUMENT_V2);
  const result = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    ...projected,
    apiKeyEnv: "IGNORED_DRY_RUN_KEY"
  });

  assert.equal(result, INITIAL_SETTINGS_DOCUMENT_V2);
});

test("canonical base URL whitespace and trailing slashes are an exact no-op", () => {
  const projected = basicSettingsFromDocument(DOCUMENT);
  const result = applyBasicSettingsDraft(DOCUMENT, {
    ...projected,
    baseUrl: `  ${projected.baseUrl}///  `
  });

  assert.equal(result, DOCUMENT);
  assert.equal(result.connections.active, DOCUMENT.connections.active);
});

test("non-identity edits preserve hidden connection and model metadata", () => {
  const projected = basicSettingsFromDocument(DOCUMENT);
  const updated = applyBasicSettingsDraft(DOCUMENT, {
    ...projected,
    apiKeyEnv: "NEW_KEY",
    temperature: 0.25,
    maxTokens: 3_333,
    systemPrompt: "New prose voice"
  });

  assert.deepEqual(updated.connections.active, {
    ...DOCUMENT.connections.active!,
    auth: { type: "bearer-env", env: "NEW_KEY" }
  });
  assert.deepEqual(updated.models.active, DOCUMENT.models.active);
});

test("basic settings update only fields owned by the active default route", () => {
  const updated = applyBasicSettingsDraft(DOCUMENT, {
    provider: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1/",
    model: "new-model",
    apiKeyEnv: "OPENROUTER_API_KEY",
    temperature: 0.4,
    maxTokens: 3_000,
    systemPrompt: "New brief",
    contextWindow: 128_000
  });
  const activeConnection = updated.connections.active!;
  const originalConnection = DOCUMENT.connections.active!;
  const activeModel = updated.models.active!;
  const activeProfile = updated.profiles.default!;

  assert.equal(activeConnection.preset, "openrouter");
  assert.equal(activeConnection.baseUrl, "https://openrouter.ai/api/v1");
  assert.deepEqual(activeConnection.headers, []);
  assert.deepEqual(activeConnection.timeouts, originalConnection.timeouts);
  assert.deepEqual(updated.connections.untouched, DOCUMENT.connections.untouched);
  assert.deepEqual(activeModel.discovered, {});
  assert.equal(activeModel.overrides.maxOutputTokens, undefined);
  assert.equal(activeModel.overrides.contextWindow, 128_000);
  assert.equal(activeModel.capabilities.temperature, "supported");
  assert.equal(activeProfile.effort, "high");
  assert.equal(activeProfile.cachePolicy, "long");
  assert.deepEqual(updated.profiles.utility, DOCUMENT.profiles.utility);
  assert.equal(updated.writing.defaultAuthorBrief, "New brief");
});

test("model identity changes reset owned metadata and use Anthropic capabilities", () => {
  const updated = applyBasicSettingsDraft(DOCUMENT, {
    ...basicSettingsFromDocument(DOCUMENT),
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet",
    apiKeyEnv: "ANTHROPIC_API_KEY"
  });
  const model = updated.models.active!;

  assert.deepEqual(model.discovered, {});
  assert.deepEqual(model.overrides, {});
  assert.deepEqual(model.capabilities, {
    temperature: "supported",
    assistantPrefill: "unknown",
    reasoningEffort: "unknown",
    promptCaching: "unknown"
  });
  assert.equal(model.name, "claude-sonnet");
  assert.deepEqual(updated.connections.active?.headers, []);
  assert.deepEqual(updated.connections.active?.timeouts, {
    responseHeaderMs: 120_000,
    firstTokenMs: 120_000,
    idleMs: 120_000,
    totalMs: 1_800_000
  });
});

test("an Anthropic protocol on a custom gateway never claims the official preset", () => {
  const updated = applyBasicSettingsDraft(DOCUMENT, {
    ...basicSettingsFromDocument(DOCUMENT),
    provider: "anthropic",
    baseUrl: "https://gateway.example/v1",
    model: "claude-sonnet-5",
    apiKeyEnv: "ANTHROPIC_API_KEY"
  });

  assert.equal(updated.connections.active?.protocol, "anthropic-messages");
  assert.equal(updated.connections.active?.preset, "custom");
});

test("stored auth keeps one secret ID and adapts across provider switches", () => {
  const secretId = "active";
  const secret = "stored-switch-secret";
  const openAi: SettingsDocumentV2 = {
    ...DOCUMENT,
    connections: {
      ...DOCUMENT.connections,
      active: {
        ...DOCUMENT.connections.active!,
        auth: { type: "bearer-stored", secretId }
      }
    }
  };
  const anthropic = applyBasicSettingsDraft(openAi, {
    ...basicSettingsFromDocument(openAi),
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet"
  });

  assert.deepEqual(anthropic.connections.active?.auth, {
    type: "header-stored",
    name: "x-api-key",
    secretId
  });
  assert.deepEqual(resolvedStoredHeaders(anthropic, secret), {
    headers: { "x-api-key": secret },
    secrets: [secret]
  });

  const switchedBack = applyBasicSettingsDraft(anthropic, {
    ...basicSettingsFromDocument(anthropic),
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6"
  });
  assert.deepEqual(switchedBack.connections.active?.auth, {
    type: "bearer-stored",
    secretId
  });
  assert.deepEqual(resolvedStoredHeaders(switchedBack, secret), {
    headers: { authorization: `Bearer ${secret}` },
    secrets: [secret]
  });
});

test("same-protocol origin changes clear secret headers but preserve transport tuning", () => {
  const updated = applyBasicSettingsDraft(DOCUMENT, {
    ...basicSettingsFromDocument(DOCUMENT),
    baseUrl: "https://new.example/v1",
    model: "new-model"
  });

  assert.deepEqual(updated.connections.active?.headers, []);
  assert.deepEqual(updated.connections.active?.timeouts, DOCUMENT.connections.active?.timeouts);
  assert.deepEqual(updated.models.active?.discovered, {});
  assert.deepEqual(updated.models.active?.overrides, {});
  assert.deepEqual(updated.models.active?.capabilities, {
    temperature: "supported",
    assistantPrefill: "unknown",
    reasoningEffort: "unknown",
    promptCaching: "unknown"
  });
});

function resolvedStoredHeaders(
  document: SettingsDocumentV2,
  secret: string
): ReturnType<typeof resolveProviderHeaders> {
  const connection = document.connections.active!;
  const model = document.models.active!;
  const auth = connection.auth;
  if (auth.type !== "bearer-stored" && auth.type !== "header-stored") {
    throw new Error("test document must use stored auth");
  }
  return resolveProviderHeaders(
    attachProviderRuntime(
      basicSettingsFromDocument(document),
      providerRuntimeFromV2(
        connection,
        "default",
        model.capabilities,
        {},
        new Map([[auth.secretId, secret]])
      ),
      true
    ),
    {}
  );
}

test("same-origin path changes preserve secret headers and transport tuning", () => {
  const updated = applyBasicSettingsDraft(DOCUMENT, {
    ...basicSettingsFromDocument(DOCUMENT),
    baseUrl: "https://old.example/compatible/v1"
  });

  assert.deepEqual(updated.connections.active?.headers, DOCUMENT.connections.active?.headers);
  assert.deepEqual(updated.connections.active?.timeouts, DOCUMENT.connections.active?.timeouts);
});

test("pending views display the candidate while retaining the active effective projection", () => {
  const candidate = applyBasicSettingsDraft(DOCUMENT, {
    ...basicSettingsFromDocument(DOCUMENT),
    model: "candidate-model",
    contextWindow: null
  });
  const active = basicSettingsFromDocument(DOCUMENT);
  const view = {
    dataFormat: 2 as const,
    editable: true as const,
    stateGeneration: 2,
    activeRevision: 1,
    pendingRevision: 2,
    document: candidate,
    effective: active,
    effectiveProse: active,
    lastActivationOutcome: null
  };

  assert.equal(basicSettingsForDisplay(view).model, "candidate-model");
  assert.equal(view.effective.model, "old-model");
});

test("clean editable views display their document while format-1 views display effective settings", () => {
  const effective = {
    ...basicSettingsFromDocument(DOCUMENT),
    model: "runtime-only-model"
  };
  const editable = {
    dataFormat: 2 as const,
    editable: true as const,
    stateGeneration: 1,
    activeRevision: 1,
    pendingRevision: null,
    document: DOCUMENT,
    effective,
    effectiveProse: effective,
    lastActivationOutcome: null
  };
  const legacy = {
    dataFormat: 1 as const,
    editable: false as const,
    stateGeneration: null,
    activeRevision: null,
    pendingRevision: null,
    document: null,
    effective,
    effectiveProse: effective,
    lastActivationOutcome: null
  };

  assert.equal(basicSettingsForDisplay(editable).model, "old-model");
  assert.equal(basicSettingsForDisplay(legacy).model, "runtime-only-model");
});

test("clearing a discovered-only context window persists an unknown projection", () => {
  const document: SettingsDocumentV2 = {
    ...DOCUMENT,
    profiles: {
      ...DOCUMENT.profiles,
      default: { ...DOCUMENT.profiles.default!, effort: "default" }
    }
  };
  const projected = basicSettingsFromDocument(document);
  assert.equal(projected.contextWindow, 64_000);

  const updated = applyBasicSettingsDraft(document, {
    ...projected,
    contextWindow: null
  });

  assert.deepEqual(updated.models.active?.discovered, { maxOutputTokens: 8_192 });
  assert.deepEqual(updated.models.active?.overrides, { maxOutputTokens: 4_096 });
  assert.equal(basicSettingsFromDocument(updated).contextWindow, null);
  assert.deepEqual(validateSettingsDocumentV2(updated), updated);
});

test("switching to dry-run removes transport-only fields and remains projectable", () => {
  const insecure: SettingsDocumentV2 = {
    ...DOCUMENT,
    connections: {
      ...DOCUMENT.connections,
      active: { ...DOCUMENT.connections.active!, allowInsecureHttp: true }
    }
  };
  const updated = applyBasicSettingsDraft(insecure, {
    provider: "dry-run",
    baseUrl: "",
    model: "",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 64,
    systemPrompt: "Dry",
    contextWindow: null
  });
  const activeConnection = updated.connections.active!;

  assert.equal(activeConnection.allowInsecureHttp, undefined);
  assert.equal(activeConnection.baseUrl, null);
  assert.deepEqual(activeConnection.headers, []);
  assert.deepEqual(activeConnection.auth, { type: "none" });
  assert.deepEqual(basicSettingsFromDocument(updated), {
    provider: "dry-run",
    baseUrl: "",
    model: "",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 64,
    systemPrompt: "Dry",
    contextWindow: null
  });
});

test("switching a local connection to hosted HTTPS removes its insecure opt-in", () => {
  const insecure: SettingsDocumentV2 = {
    ...DOCUMENT,
    connections: {
      ...DOCUMENT.connections,
      active: {
        ...DOCUMENT.connections.active!,
        baseUrl: "http://192.168.1.10:1234/v1",
        allowInsecureHttp: true
      }
    }
  };

  const updated = applyBasicSettingsDraft(insecure, {
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    model: "hosted-model",
    apiKeyEnv: "HOSTED_MODEL_KEY",
    temperature: 0.5,
    maxTokens: 1_024,
    systemPrompt: "Hosted",
    contextWindow: null
  });

  assert.equal(updated.connections.active?.allowInsecureHttp, undefined);
  assert.equal(updated.connections.active?.baseUrl, "https://models.example/v1");
});

test("toggling LAN HTTP opt-in on HTTPS is normalized away before validation", () => {
  const updated = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
    ...basicSettingsFromDocument(INITIAL_SETTINGS_DOCUMENT_V2),
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    allowInsecureHttp: true
  });

  assert.equal(
    updated.connections["builtin:dry-run"]?.allowInsecureHttp,
    undefined
  );
  assert.deepEqual(validateSettingsDocumentV2(updated), updated);
});

test("stored auth survives unrelated base-URL and model edits", () => {
  const stored: SettingsDocumentV2 = {
    ...DOCUMENT,
    connections: {
      ...DOCUMENT.connections,
      active: {
        ...DOCUMENT.connections.active!,
        auth: { type: "bearer-stored", secretId: "active" }
      }
    }
  };
  const baseEdited = applyBasicSettingsDraft(stored, {
    ...basicSettingsFromDocument(stored),
    baseUrl: "https://models.example/v2"
  });
  assert.deepEqual(baseEdited.connections.active?.auth, {
    type: "bearer-stored",
    secretId: "active"
  });

  const modelEdited = applyBasicSettingsDraft(baseEdited, {
    ...basicSettingsFromDocument(baseEdited),
    model: "replacement-model"
  });
  assert.deepEqual(modelEdited.connections.active?.auth, {
    type: "bearer-stored",
    secretId: "active"
  });
});

test("LAN opt-in survives base-URL and model edits", () => {
  const insecure: SettingsDocumentV2 = {
    ...DOCUMENT,
    profiles: {
      ...DOCUMENT.profiles,
      default: { ...DOCUMENT.profiles.default!, effort: "default" }
    },
    connections: {
      ...DOCUMENT.connections,
      active: {
        ...DOCUMENT.connections.active!,
        baseUrl: "http://192.168.1.10:1234/v1",
        auth: { type: "none" },
        headers: [],
        allowInsecureHttp: true
      }
    }
  };
  const baseEdited = applyBasicSettingsDraft(insecure, {
    ...basicSettingsFromDocument(insecure),
    baseUrl: "http://gpu-box.local:11434/v1"
  });
  assert.equal(baseEdited.connections.active?.allowInsecureHttp, true);
  const modelEdited = applyBasicSettingsDraft(baseEdited, {
    ...basicSettingsFromDocument(baseEdited),
    model: "replacement-model"
  });
  assert.equal(modelEdited.connections.active?.allowInsecureHttp, true);
  assert.deepEqual(validateSettingsDocumentV2(modelEdited), modelEdited);
});

test("basic settings accept keyless loopback HTTP and infer local presets", () => {
  const cases = [
    ["http://localhost:1234/v1", "lm-studio"],
    ["http://127.0.0.1:11434/v1", "ollama"],
    ["http://127.0.0.1:8080/v1", "llama-cpp"],
    ["http://127.0.0.1:5001/v1", "koboldcpp"]
  ] as const;
  for (const [baseUrl, preset] of cases) {
    const updated = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
      provider: "openai-compatible",
      baseUrl,
      model: "local-model",
      apiKeyEnv: null,
      temperature: null,
      maxTokens: 64,
      systemPrompt: "Local",
      contextWindow: null
    });
    const connection = updated.connections["builtin:dry-run"];
    assert.equal(connection?.baseUrl, baseUrl);
    assert.equal(connection?.preset, preset);
    assert.deepEqual(connection?.auth, { type: "none" });
    assert.deepEqual(validateSettingsDocumentV2(updated), updated);
  }
});

test("basic settings accept opted-in keyless private and named LAN HTTP", () => {
  for (const baseUrl of [
    "http://192.168.1.50:8080/v1",
    "http://gpu-box.local:11434/v1",
    "http://gpu-box:11434/v1"
  ]) {
    const updated = applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
      ...basicSettingsFromDocument(INITIAL_SETTINGS_DOCUMENT_V2),
      provider: "openai-compatible",
      baseUrl,
      model: "lan-model",
      allowInsecureHttp: true
    });
    assert.equal(updated.connections["builtin:dry-run"]?.allowInsecureHttp, true);
    assert.deepEqual(validateSettingsDocumentV2(updated), updated);
  }
});

test("basic settings fail closed for unsupported network inputs", () => {
  const draft = {
    provider: "openai-compatible" as const,
    baseUrl: "http://192.168.1.10:1234/v1",
    model: "model",
    apiKeyEnv: null,
    temperature: null,
    maxTokens: 64,
    systemPrompt: "",
    contextWindow: null
  };
  assert.throws(
    () => applyBasicSettingsDraft(DOCUMENT, draft),
    /require HTTPS/
  );
  assert.throws(
    () => applyBasicSettingsDraft(DOCUMENT, {
      ...draft,
      baseUrl: "http://models.example.com/v1",
      allowInsecureHttp: true
    }),
    /require HTTPS/
  );
  assert.throws(
    () => applyBasicSettingsDraft(DOCUMENT, {
      ...draft,
      baseUrl: "http://10.example/v1",
      allowInsecureHttp: true
    }),
    /require HTTPS/
  );
  assert.throws(
    () => applyBasicSettingsDraft(DOCUMENT, {
      ...draft,
      baseUrl: "http://localhost:5001/v1",
      apiKeyEnv: "LOCAL_KEY"
    }),
    /cannot carry an API key/
  );
  assert.throws(
    () => applyBasicSettingsDraft(DOCUMENT, {
      ...draft,
      baseUrl: "http://localhost:5001/v1?"
    }),
    /cannot contain credentials, a query, or a fragment/
  );
  assert.throws(
    () => applyBasicSettingsDraft(DOCUMENT, { ...draft, baseUrl: "https://example.com", model: " " }),
    /Model name cannot be empty/
  );
});
