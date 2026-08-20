import { expect, test } from "bun:test";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import { resolveSettingsProfile } from "../../shared/settings-route.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import { createSettingsProfile } from "../src/settings-profile-draft.js";
import { settingsDraftChanged } from "../src/settings-overlay-model.js";
import {
  deferred,
  draftRow,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import {
  configureNetworkSource,
  installHostModelDiscovery
} from "./settings-model-provenance-test-helpers.js";

test("an arrow affirms the only automatic model", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  installHostModelDiscovery(source);

  await openSettings(press);
  state.settings!.viewMode = "advanced";
  await draftRow(press, state, "model", "");
  await selectRow(press, state, "model");
  await press(key("right"));
  await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
  await backend.whenIdle();

  expect(state.settings?.draft.generation.model).toBe("model-api");
});

test("an unchanged model choice does not fork a shared model", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  if (!source.settingsView.editable) throw new Error("demo settings must be editable");
  const profileId = source.settingsView.document.routing.default;
  const modelId = source.settingsView.document.profiles[profileId]!.modelId;
  const documentWithContext = {
    ...source.settingsView.document,
    models: {
      ...source.settingsView.document.models,
      [modelId]: {
        ...source.settingsView.document.models[modelId]!,
        discovered: { contextWindow: 32_768 }
      }
    }
  };
  const created = createSettingsProfile(
    documentWithContext,
    profileId
  );
  if ("error" in created) throw new Error(created.error);
  source.settingsView = { ...source.settingsView, document: created.document };
  source.api.getSettings = async () => source.settingsView;
  source.api.discoverModels = async () => ({
    observedAt: "2026-01-01T00:00:00.000Z",
    models: [{
      remoteId: "novelist-a",
      name: "Novelist A",
      contextWindow: 32_768,
      maxOutputTokens: null,
      source: "openai-models"
    }]
  });

  await openSettings(press);
  state.settings!.viewMode = "advanced";
  const document = state.settings!.draft.document;
  await selectRow(press, state, "model");
  await press(key("right"));

  expect(state.settings!.draft.document).toBe(document);
  expect(settingsDraftChanged(state.settings!)).toBeFalse();
});

test("a prompt format edit keeps its automatic model target", async () => {
  const { source, state, press } = settingsHarness();
  if (!source.settingsView.editable) throw new Error("demo settings must be editable");
  const settings = {
    ...source.settings,
    provider: "text-completion" as const,
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "text-model",
    apiKeyEnv: null
  };
  const document = applyBasicSettingsDraft(source.settingsView.document, settings);
  const view: SettingsView = {
    ...source.settingsView,
    document,
    effective: settings,
    effectiveProse: settings
  };
  source.settingsView = view;
  source.settings = settings;
  source.api.getSettings = async () => view;
  let calls = 0;
  source.api.discoverModels = async () => {
    calls += 1;
    if (calls > 1) throw new Error("prompt format must not refresh models");
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId: "text-model",
        name: "text-model",
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    };
  };

  await openSettings(press);
  state.settings!.viewMode = "advanced";
  await draftRow(press, state, "model", "");
  await selectRow(press, state, "text-prompt-format");
  await press(key("right"));

  expect(calls).toBe(1);
  expect(state.settings?.draft.generation.model).toBe("text-model");
});

test("unchanged inline model keeps its context window", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);

  await openSettings(press);
  state.settings!.viewMode = "advanced";
  await draftRow(press, state, "context-window", "32768");
  await draftRow(press, state, "model", "novelist-a");

  expect(state.settings?.draft.generation.contextWindow).toBe(32_768);
  expect(resolveSettingsProfile(
    state.settings!.draft.document!,
    state.settings!.draft.selectedProfileId!
  ).model.overrides.contextWindow).toBe(32_768);
});

for (const [catalog, nextIds] of [
  ["empty", []],
  ["multiple", ["model-beta-a", "model-beta-b"]]
] as const) {
test(`${catalog} next catalog clears an unavailable automatic model`, async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  let calls = 0;
  const refreshEntered = deferred<void>();
  const refreshGate = deferred<void>();
  source.api.discoverModels = async () => {
    calls += 1;
    if (calls > 1) {
      refreshEntered.resolve();
      await refreshGate.promise;
    }
    const ids = calls === 1 ? ["model-api"] : nextIds;
    return {
      observedAt: "2026-01-01T00:00:00.000Z",
      models: ids.map((remoteId) => ({
        remoteId,
        name: remoteId,
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models" as const
      }))
    };
  };

  await openSettings(press);
  state.settings!.viewMode = "advanced";
  await draftRow(press, state, "model", "");
  await draftRow(press, state, "context-window", "12345");
  const editingKey = draftRow(press, state, "api-key", "replacement-secret");
  await refreshEntered.promise;
  expect(state.settings?.draft.generation.contextWindow).toBe(12_345);
  refreshGate.resolve();
  await editingKey;
  await backend.whenIdle();

  expect(state.settings?.draft.generation).toMatchObject({
    model: "",
    contextWindow: 12_345
  });
});
}
