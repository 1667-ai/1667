import assert from "node:assert/strict";
import test from "node:test";
import {
  providerRuntimeFor,
  resolveProviderHeaders
} from "../server/provider-runtime.js";
import { SettingsStore } from "../server/settings.js";
import type { SettingsDocumentV2 } from "../shared/settings-v2-types.js";
import { providerProbeRouteFromDocument } from "../shared/provider-probe-route-v1.js";
import type { GenerationSettings } from "../shared/types.js";
import {
  FIXED_TIME,
  MUTATION_A,
  credentialedDocument,
  initializedFormat2Directory,
  saveCommand
} from "./settings-store-fixtures.js";

test("provider probes recover runtime policy from an unrouted active connection", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-prose-probe-"
  );
  const base = credentialedDocument("AI_1667_DEFAULT_ROUTE_KEY");
  const defaultProfile = base.profiles[base.routing.default]!;
  const defaultModel = base.models[defaultProfile.modelId]!;
  const defaultConnection = base.connections[defaultModel.connectionId]!;
  const document: SettingsDocumentV2 = {
    ...base,
    connections: {
      ...base.connections,
      "prose:connection": {
        ...defaultConnection,
        name: "Prose connection",
        baseUrl: "https://prose.example/v1",
        auth: {
          type: "bearer-env",
          env: "AI_1667_PROSE_ROUTE_KEY"
        }
      }
    },
    models: {
      ...base.models,
      "prose:model": {
        ...defaultModel,
        name: "Prose model",
        connectionId: "prose:connection"
      }
    },
    profiles: base.profiles,
    routing: base.routing
  };
  const first = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await first.init(2);
  await first.save(saveCommand(MUTATION_A, 1, document));

  const restarted = new SettingsStore(dataDir, {
    environment: {
      AI_1667_DEFAULT_ROUTE_KEY: "default-secret",
      AI_1667_PROSE_ROUTE_KEY: "prose-secret"
    },
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await restarted.init(2);
  const serialized: GenerationSettings = {
    provider: "openai-compatible",
    baseUrl: "https://prose.example/v1",
    model: defaultModel.remoteId,
    apiKeyEnv: "AI_1667_PROSE_ROUTE_KEY",
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  };
  const admitted = await restarted.assertProviderProbeSupported(serialized);

  assert.equal(admitted.baseUrl, "https://prose.example/v1");
  assert.deepEqual(providerRuntimeFor(admitted).auth, {
    type: "bearer-env",
    env: "AI_1667_PROSE_ROUTE_KEY"
  });
  assert.equal(
    resolveProviderHeaders(admitted, {}).headers.authorization,
    "Bearer prose-secret"
  );
});

test("provider probes use a unique active model to disambiguate shared endpoints", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-model-probe-"
  );
  const base = credentialedDocument("AI_1667_SHARED_ROUTE_KEY");
  const profile = base.profiles[base.routing.default]!;
  const model = base.models[profile.modelId]!;
  const connection = base.connections[model.connectionId]!;
  const document: SettingsDocumentV2 = {
    ...base,
    connections: {
      ...base.connections,
      secondary: {
        ...connection,
        name: "Secondary",
        preset: "ollama"
      }
    },
    models: {
      ...base.models,
      secondary: {
        ...model,
        connectionId: "secondary",
        remoteId: "secondary-model",
        name: "Secondary model"
      }
    }
  };
  const first = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await first.init(2);
  await first.save(saveCommand(MUTATION_A, 1, document));

  const restarted = new SettingsStore(dataDir, {
    environment: {
      AI_1667_SHARED_ROUTE_KEY: "shared-secret"
    },
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await restarted.init(2);
  const admitted = await restarted.assertProviderProbeSupported({
    provider: "openai-compatible",
    baseUrl: connection.baseUrl ?? "",
    model: "secondary-model",
    apiKeyEnv: "AI_1667_SHARED_ROUTE_KEY",
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  });

  assert.equal(providerRuntimeFor(admitted).preset, "ollama");
});

test("provider probes collapse duplicate connections with identical runtime policy", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-duplicate-probe-"
  );
  const base = credentialedDocument("AI_1667_DUPLICATE_ROUTE_KEY");
  const profile = base.profiles[base.routing.default]!;
  const model = base.models[profile.modelId]!;
  const connection = base.connections[model.connectionId]!;
  const document: SettingsDocumentV2 = {
    ...base,
    connections: {
      ...base.connections,
      alias: { ...connection }
    },
    models: {
      ...base.models,
      alias: {
        ...model,
        connectionId: "alias",
        name: "Alias model"
      }
    }
  };
  const first = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await first.init(2);
  await first.save(saveCommand(MUTATION_A, 1, document));

  const restarted = new SettingsStore(dataDir, {
    environment: {
      AI_1667_DUPLICATE_ROUTE_KEY: "duplicate-secret"
    },
    now: () => FIXED_TIME,
    validateCandidate: async () => true
  });
  await restarted.init(2);
  const admitted = await restarted.assertProviderProbeSupported({
    provider: "openai-compatible",
    baseUrl: connection.baseUrl ?? "",
    model: model.remoteId,
    apiKeyEnv: "AI_1667_DUPLICATE_ROUTE_KEY",
    temperature: 0,
    maxTokens: 128,
    systemPrompt: "Test.",
    contextWindow: null
  });

  assert.equal(providerRuntimeFor(admitted).preset, connection.preset);
});

test("settings-document probes preserve credentialless draft connection policy", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-document-probe-"
  );
  const store = new SettingsStore(dataDir, {
    environment: {},
    now: () => FIXED_TIME
  });
  await store.init(2);
  const base = credentialedDocument("AI_1667_UNUSED_KEY");
  const profile = base.profiles[base.routing.default]!;
  const model = base.models[profile.modelId]!;
  const connection = base.connections[model.connectionId]!;
  const document: SettingsDocumentV2 = {
    ...base,
    connections: {
      ...base.connections,
      [model.connectionId]: {
        ...connection,
        name: "Private Kobold",
        preset: "koboldcpp",
        baseUrl: "http://192.168.1.25:5001/v1",
        auth: { type: "none" },
        headers: [],
        allowInsecureHttp: true
      }
    },
    models: {
      ...base.models,
      [profile.modelId]: {
        ...model,
        remoteId: ""
      }
    }
  };

  const admitted = await store.resolveProviderProbe(
    providerProbeRouteFromDocument(document)
  );

  assert.equal(admitted.baseUrl, "http://192.168.1.25:5001/v1");
  assert.equal(admitted.model, "");
  assert.equal(providerRuntimeFor(admitted).preset, "koboldcpp");
  assert.equal(providerRuntimeFor(admitted).allowInsecureHttp, true);
});

test("settings-document probes require changed credential targets to activate", async (t) => {
  const dataDir = await initializedFormat2Directory(
    t,
    "1667-settings-credential-probe-"
  );
  const store = new SettingsStore(dataDir, {
    environment: { AI_1667_NEW_TARGET_KEY: "secret" },
    now: () => FIXED_TIME
  });
  await store.init(2);
  const document = credentialedDocument("AI_1667_NEW_TARGET_KEY");

  await assert.rejects(
    store.resolveProviderProbe(providerProbeRouteFromDocument(document)),
    /must be saved and activated/
  );
});
