import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type {
  SaveSettingsCommand,
  SettingsView
} from "../../shared/settings-v2-types.js";
import {
  deferred,
  generationFromProbeTarget,
  settingsHarness
} from "./settings-test-harness.js";

export function installHostModelDiscovery(
  source: ReturnType<typeof settingsHarness>["source"]
): void {
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
}

export function installSettingsSave(
  source: ReturnType<typeof settingsHarness>["source"],
  blocked = false
): {
  saveEntered: ReturnType<typeof deferred<void>>;
  saveGate: ReturnType<typeof deferred<void>>;
} {
  const saveEntered = deferred<void>();
  const saveGate = deferred<void>();
  if (!blocked) saveGate.resolve();
  source.api.saveSettings = async (command: SaveSettingsCommand) => {
    saveEntered.resolve();
    await saveGate.promise;
    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const effective = basicSettingsFromDocument(command.document);
    source.settingsView = {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document: command.document,
      effective,
      effectiveProse: effective
    };
    return {
      kind: "settings",
      settingsStateGeneration: source.settingsView.stateGeneration,
      activeSettingsRevision: source.settingsView.activeRevision,
      pendingSettingsRevision: null,
      activationOutcome: null
    };
  };
  return { saveEntered, saveGate };
}

export function installContextDiscovery(
  source: ReturnType<typeof settingsHarness>["source"],
  remoteId = "loaded-model"
): void {
  source.api.discoverModels = async () => ({
    observedAt: "2026-01-01T00:00:00.000Z",
    models: [{
      remoteId,
      name: remoteId,
      contextWindow: 65_536,
      maxOutputTokens: null,
      source: "openai-models"
    }]
  });
}

export function configureNetworkSource(
  source: ReturnType<typeof settingsHarness>["source"]
): void {
  if (!source.settingsView.editable) throw new Error("demo settings must be editable");
  const settings = {
    ...source.settings,
    provider: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    model: "novelist-a",
    apiKeyEnv: "OPENAI_API_KEY"
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
}
