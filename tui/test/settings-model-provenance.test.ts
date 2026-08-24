import { expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import {
  createSettingsProfile,
  isolateSettingsProfileModel
} from "../src/settings-profile-draft.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import { settingsDraftChanged } from "../src/settings-overlay-model.js";
import {
  draftRow,
  generationFromProbeTarget,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import {
  configureNetworkSource,
  installContextDiscovery,
  installHostModelDiscovery,
  installSettingsSave
} from "./settings-model-provenance-test-helpers.js";

test("deleted profile model provenance does not reach a reused profile ID", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.getSettings = async () => source.settingsView;
  source.api.discoverModels = async (target) => {
    const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
    const remoteId = `model-${host.split(".")[0]}`;
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId,
        name: remoteId,
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await backend.whenIdle();
  await selectRow(press, state, "profile");
  await press(key("N"));
  await selectRow(press, state, "model");
  await draftRow(press, state, "model", "");
  await selectRow(press, state, "profile");
  await press(key("d"));
  await press(key("d"));
  await press(key("n"));
  await draftRow(press, state, "model", "model-alpha");

  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("model-alpha");
});

for (const cloneKey of ["n", "N"] as const) {
test(`${cloneKey} profile clone keeps model and context ownership`, async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.discoverModels = async (target) => {
    const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
    const remoteId = `model-${host.split(".")[0]}`;
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId,
        name: remoteId,
        contextWindow: 65_536,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await draftRow(press, state, "context-window", "12345");
  await selectRow(press, state, "profile");
  await press(key(cloneKey));
  installContextDiscovery(source, "model-beta");
  await draftRow(press, state, "api-key", "replacement-secret");
  await backend.whenIdle();

  expect(state.settings?.draft.generation).toMatchObject({
    model: "model-beta",
    contextWindow: 12_345
  });
});
}

test("blank context sentinel accepts cached model metadata", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  installContextDiscovery(source);

  await openSettings(press);
  await draftRow(press, state, "context-window", "12345");
  await draftRow(press, state, "context-window", "");
  await draftRow(press, state, "model", "");

  expect(state.settings?.draft.generation.contextWindow).toBe(65_536);
});

test("context stepper auto sentinel accepts cached model metadata", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  installContextDiscovery(source);

  await openSettings(press);
  await draftRow(press, state, "context-window", "1");
  await selectRow(press, state, "context-window");
  await press(key("left"));
  await draftRow(press, state, "model", "");

  expect(state.settings?.draft.generation.contextWindow).toBe(65_536);
});

test("equal discovered context remains a manual limit", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  if (!source.settingsView.editable) throw new Error("demo settings must be editable");
  const originalModelId = source.settingsView.document.profiles[
    source.settingsView.document.routing.default
  ]!.modelId;
  const created = createSettingsProfile(
    source.settingsView.document,
    source.settingsView.document.routing.default
  );
  if ("error" in created) throw new Error(created.error);
  source.settingsView = {
    ...source.settingsView,
    document: created.document
  };
  source.api.getSettings = async () => source.settingsView;
  installSettingsSave(source);
  let calls = 0;
  source.api.discoverModels = async () => {
    calls += 1;
    const first = {
      remoteId: "loaded-model",
      name: "Loaded Model",
      contextWindow: 65_536,
      maxOutputTokens: null,
      source: "openai-models" as const
    };
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{ ...first, contextWindow: calls === 1 ? 65_536 : 32_768 }]
    };
  };

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "context-window", "65536");
  await press(key("s"));
  if (!source.settingsView.editable) throw new Error("saved settings must be editable");
  const selectedModelId = source.settingsView.document.profiles[
    source.settingsView.document.routing.default
  ]!.modelId;
  expect(selectedModelId).not.toBe(originalModelId);
  expect(source.settingsView.document.models[originalModelId]!.overrides.contextWindow)
    .toBe(undefined);
  expect(source.settingsView.document.models[selectedModelId]!.overrides.contextWindow)
    .toBe(65_536);
  await press(key("escape"));
  await openSettings(press);
  await draftRow(press, state, "api-key", "first-secret");

  expect(state.settings?.draft.generation.contextWindow).toBe(65_536);
});

test("a target change preserves a manual context from an automatic model", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  installHostModelDiscovery(source);

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await draftRow(press, state, "context-window", "12345");
  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation).toMatchObject({
    model: "model-beta",
    contextWindow: 12_345
  });
});

test("a target change replaces context metadata from an automatic model", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.discoverModels = async (target) => {
    const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
    const beta = host === "beta.example.test";
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId: beta ? "model-beta" : "model-api",
        name: beta ? "Model Beta" : "Model API",
        contextWindow: beta ? 32_768 : 65_536,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };

  await openSettings(press);
  await draftRow(press, state, "model", "");
  expect(state.settings?.draft.generation.contextWindow).toBe(65_536);
  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation).toMatchObject({
    model: "model-beta",
    contextWindow: 32_768
  });
});

test("saved automatic model becomes an explicit model", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.getSettings = async () => source.settingsView;
  installHostModelDiscovery(source);
  installSettingsSave(source);

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await press(key("s"));
  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("model-alpha");
});

test("save acknowledges an automatic model that equals the saved value", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  if (!source.settingsView.editable) throw new Error("demo settings must be editable");
  const created = createSettingsProfile(
    source.settingsView.document,
    source.settingsView.document.routing.default
  );
  if ("error" in created) throw new Error(created.error);
  source.settingsView = {
    ...source.settingsView,
    document: isolateSettingsProfileModel(
      created.document,
      created.document.routing.default
    )
  };
  source.api.getSettings = async () => source.settingsView;
  source.api.discoverModels = async (target) => {
    const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
    const remoteId = host === "api.openai.com" ? "novelist-a" : "model-alpha";
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId,
        name: remoteId,
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };
  let saves = 0;
  source.api.saveSettings = async () => {
    saves += 1;
    throw new Error("an equal draft must not reach the server");
  };
  // The sole discovered choice auto-fills with no known context window,
  // which now also fires a background probe. Report nothing found so this
  // draft stays equal to the saved value, as the test's premise requires.
  source.api.probeContextWindow = async () => ({ contextWindow: null });

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await backend.whenIdle();
  await selectRow(press, state, "profile");
  await press(key("right"));
  await press(key("s"));
  expect(saves).toBe(0);
  expect(state.settings?.draft.selectedProfileId).toBe(created.profileId);
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("novelist-a");
});

test("an unrelated authoritative refresh preserves automatic ownership", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.discoverModels = async (target) => {
    const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
    const remoteId = host === "api.openai.com" ? "novelist-a" : "model-alpha";
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId,
        name: remoteId,
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };

  await openSettings(press);
  await draftRow(press, state, "model", "");
  const current = source.settingsView;
  if (!current.editable) throw new Error("demo settings must be editable");
  const effective = { ...current.effective, maxTokens: 4_096 };
  const document = applyBasicSettingsDraft(current.document, effective);
  publishSettingsView(state, source, {
    ...current,
    stateGeneration: current.stateGeneration + 1,
    activeRevision: current.activeRevision + 1,
    document,
    effective,
    effectiveProse: effective
  });

  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("model-alpha");
});

test("an authoritative model change drops old manual context ownership", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.getSettings = async () => source.settingsView;
  installSettingsSave(source);

  await openSettings(press);
  await draftRow(press, state, "context-window", "12345");
  await press(key("s"));
  const current = source.settingsView;
  if (!current.editable) throw new Error("demo settings must be editable");
  const profileId = current.document.routing.default;
  const modelId = current.document.profiles[profileId]!.modelId;
  const document = {
    ...current.document,
    models: {
      ...current.document.models,
      [modelId]: {
        ...current.document.models[modelId]!,
        remoteId: "replacement-model",
        name: "Replacement Model",
        discovered: { contextWindow: 12_345 },
        overrides: {}
      }
    }
  };
  const effective = basicSettingsFromDocument(document);

  publishSettingsView(state, source, {
    ...current,
    stateGeneration: current.stateGeneration + 1,
    activeRevision: current.activeRevision + 1,
    document,
    effective,
    effectiveProse: effective
  });

  expect(state.settings?.draft.generation.model).toBe("replacement-model");
  expect(settingsDraftChanged(state.settings!)).toBeFalse();
});

test("save acknowledges an automatic model while a newer row edit remains", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.getSettings = async () => source.settingsView;
  installHostModelDiscovery(source);
  const { saveEntered, saveGate } = installSettingsSave(source, true);

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  const saving = press(key("s"));
  await saveEntered.promise;
  await draftRow(press, state, "temperature", "0.7");
  saveGate.resolve();
  await saving;
  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation).toMatchObject({
    model: "model-alpha",
    temperature: 0.7
  });
});

test("save acknowledges an automatic model after a concurrent profile switch", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.getSettings = async () => source.settingsView;
  installHostModelDiscovery(source);
  const { saveEntered, saveGate } = installSettingsSave(source, true);

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await selectRow(press, state, "profile");
  await press(key("N"));
  await press(key("left"));
  const saving = press(key("s"));
  await saveEntered.promise;
  await selectRow(press, state, "profile");
  await press(key("right"));
  await draftRow(press, state, "temperature", "0.7");
  saveGate.resolve();
  await saving;
  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();
  expect(state.settings?.draft.generation.model).toBe("model-alpha");
  await selectRow(press, state, "profile");
  await press(key("left"));
  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("model-alpha");
});

test("save preserves automatic ownership when its target changes in flight", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.getSettings = async () => source.settingsView;
  source.api.discoverModels = async (target) => {
    const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
    const remoteId = host.startsWith("gamma") ? "model-gamma" : "shared-model";
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId,
        name: remoteId,
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };
  const { saveEntered, saveGate } = installSettingsSave(source, true);

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  const saving = press(key("s"));
  await saveEntered.promise;
  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  saveGate.resolve();
  await saving;
  await backend.whenIdle();
  await draftRow(press, state, "base-url", "https://gamma.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("model-gamma");
});

test("a failed target refresh clears the previous automatic model", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.discoverModels = async (target) => {
    const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
    if (host === "beta.example.test") throw new Error("beta is unavailable");
    const remoteId = `model-${host.split(".")[0]}`;
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId,
        name: remoteId,
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };

  await openSettings(press);
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await backend.whenIdle();
  expect(state.settings?.draft.generation.model).toBe("model-alpha");

  await draftRow(press, state, "base-url", "https://beta.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("");
  expect(state.settings?.result?.message).toContain("type a model name");
});
