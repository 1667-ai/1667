import { describe, expect, test } from "bun:test";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import type {
  SaveSettingsCommand,
  SettingsView
} from "../../shared/settings-v2-types.js";
import type { ProviderProbeTarget } from "../../shared/provider-probe-route-v1.js";
import { publishSettingsView } from "../src/overlay-publication.js";
import { settingsDraftChanged } from "../src/settings-overlay-model.js";
import { WorkerApiError } from "../src/worker-api.js";
import {
  draftRow,
  generationFromProbeTarget,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

describe("Settings save lifecycle", () => {
  test("a normalized no-op save restores the canonical draft", async () => {
    const { source, state, press } = settingsHarness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const document = {
      ...source.settingsView.document,
      models: {
        ...source.settingsView.document.models,
        demo: {
          ...source.settingsView.document.models.demo!,
          discovered: {}
        }
      }
    };
    const effective = basicSettingsFromDocument(document);
    const view = {
      ...source.settingsView,
      document,
      effective,
      effectiveProse: effective
    };
    publishSettingsView(state, source, view);
    let saves = 0;
    source.api.saveSettings = async () => {
      saves += 1;
      throw new Error("a normalized no-op must not reach the server");
    };
    source.api.discoverModels = async () => ({
      observedAt: "2026-01-01T00:00:00.000Z",
      models: []
    });
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);
    await draftRow(
      press,
      state,
      "base-url",
      "https://inactive.example.test/v1"
    );
    expect(settingsDraftChanged(state.settings!)).toBeTrue();

    await press(key("s"));

    expect(saves).toBe(0);
    expect(state.settings?.draft.generation.baseUrl).toBe("");
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
  });

  test("discard refreshes the model list for the restored provider", async () => {
    const { source, state, press } = settingsHarness();
    if (!source.settingsView.editable) {
      throw new Error("demo settings must be editable");
    }
    const active = source.settingsView;
    const candidate = {
      ...source.settings,
      provider: "openai-compatible" as const,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.2",
      apiKeyEnv: "OPENAI_API_KEY"
    };
    const staged: SettingsView = {
      ...active,
      stateGeneration: active.stateGeneration + 1,
      pendingRevision: active.activeRevision + 1,
      document: applyBasicSettingsDraft(active.document, candidate)
    };
    source.settingsView = staged;
    source.api.getSettings = async () => source.settingsView;
    source.api.discoverModels = async () => ({
      observedAt: "2026-01-01T00:00:00.000Z",
      models: [{
        remoteId: "gpt-5.2",
        name: "GPT-5.2",
        contextWindow: null,
        maxOutputTokens: null,
        source: "openai-models"
      }]
    });
    source.api.discardPendingSettings = async () => {
      source.settingsView = {
        ...active,
        stateGeneration: staged.stateGeneration + 1
      };
      return {
        kind: "settings",
        settingsStateGeneration: source.settingsView.stateGeneration,
        activeSettingsRevision: source.settingsView.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };

    await openSettings(press);
    expect(state.settings?.modelDiscovery?.models).toHaveLength(1);
    await press(key("x"));

    expect(state.settings?.view.pendingRevision).toBe(null);
    expect(state.settings?.modelDiscovery).toBe(null);
  });

  test("keeps a staged view editable for retry, check, and discard", async () => {
    const { source, state, press } = settingsHarness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    const candidateSettings = { ...source.settings, model: "candidate-model" };
    const staged = {
      ...active,
      stateGeneration: active.stateGeneration + 3,
      pendingRevision: active.activeRevision + 1,
      document: applyBasicSettingsDraft(active.document, candidateSettings),
      lastActivationOutcome: {
        transactionId: "m1.0000000000000.00000000000000000000000000000000",
        candidateRevision: active.activeRevision + 1,
        result: "validation-failed" as const,
        errorCode: "candidate_invalid" as const,
        atStateGeneration: active.stateGeneration + 3
      }
    };
    source.settingsView = staged;
    source.api.getSettings = async () => source.settingsView;
    const probes: ProviderProbeTarget[] = [];
    source.api.checkModelServer = async (target) => {
      probes.push(target);
      return { state: "ready", message: "staged candidate is reachable" };
    };
    let expectedGeneration: number | null = null;
    source.api.discardPendingSettings = async (command) => {
      expectedGeneration = command.expectedStateGeneration;
      source.settingsView = {
        ...active,
        stateGeneration: staged.stateGeneration + 1,
        pendingRevision: null
      };
      return {
        kind: "settings",
        settingsStateGeneration: source.settingsView.stateGeneration,
        activeSettingsRevision: source.settingsView.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };

    await openSettings(press);
    expect(state.settings?.draft.generation.model).toBe("candidate-model");
    await draftRow(press, state, "model", "fixed-model");
    expect(state.settings?.draft.generation.model).toBe("fixed-model");
    expect(settingsDraftChanged(state.settings!)).toBeTrue();

    await press(key("c"));
    expect(probes).toHaveLength(1);
    expect(generationFromProbeTarget(probes[0]!).model).toBe("fixed-model");

    await press(key("x"));
    expect(expectedGeneration).toBe(staged.stateGeneration);
    expect(state.settings?.view.pendingRevision).toBe(null);
  });

  test("retries a staged activation without requiring an edit", async () => {
    const { source, state, press } = settingsHarness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const active = source.settingsView;
    const candidateSettings = { ...source.settings, model: "candidate-model" };
    const staged = {
      ...active,
      stateGeneration: active.stateGeneration + 3,
      pendingRevision: active.activeRevision + 1,
      document: applyBasicSettingsDraft(active.document, candidateSettings),
      lastActivationOutcome: {
        transactionId: "m1.0000000000000.00000000000000000000000000000000",
        candidateRevision: active.activeRevision + 1,
        result: "validation-failed" as const,
        errorCode: "candidate_invalid" as const,
        atStateGeneration: active.stateGeneration + 3
      }
    };
    source.settingsView = staged;
    source.api.getSettings = async () => source.settingsView;
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      const candidateRevision = staged.pendingRevision + 1;
      const outcome = {
        transactionId: command.mutationId,
        candidateRevision,
        result: "committed" as const,
        errorCode: null,
        atStateGeneration: staged.stateGeneration + 6
      };
      source.settingsView = {
        ...active,
        stateGeneration: staged.stateGeneration + 6,
        activeRevision: candidateRevision,
        pendingRevision: null,
        document: command.document,
        effective: basicSettingsFromDocument(command.document),
        effectiveProse: basicSettingsFromDocument(command.document),
        lastActivationOutcome: outcome
      };
      return {
        kind: "settings",
        settingsStateGeneration: staged.stateGeneration + 1,
        activeSettingsRevision: staged.activeRevision,
        pendingSettingsRevision: candidateRevision,
        activationOutcome: outcome
      };
    };

    await openSettings(press);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
    await press(key("s"));

    expect(commands).toHaveLength(1);
    expect(basicSettingsFromDocument(commands[0]!.document).model)
      .toBe("candidate-model");
    expect(commands[0]!.expectedStateGeneration).toBe(staged.stateGeneration);
    expect(state.toast).toBe("settings saved · credentials active");
    expect(state.settings?.view.pendingRevision).toBe(null);
  });

  test("refreshes the base after a conflict and retains the inline draft", async () => {
    const { source, state, press } = settingsHarness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const original = source.settingsView;
    const refreshedSettings = { ...original.effective, maxTokens: 4_096 };
    const refreshed = {
      ...original,
      stateGeneration: original.stateGeneration + 1,
      activeRevision: original.activeRevision + 1,
      document: applyBasicSettingsDraft(original.document, refreshedSettings),
      effective: refreshedSettings,
      effectiveProse: refreshedSettings
    };
    const commands: SaveSettingsCommand[] = [];
    let current: SettingsView = original;
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (commands.length === 1) {
        current = refreshed;
        throw new WorkerApiError(createFailureEnvelope({
          code: "revision_conflict",
          message: "Settings changed since this edit began.",
          status: 409
        }));
      }
      if (!current.editable) throw new Error("refreshed settings must be editable");
      const effective = basicSettingsFromDocument(command.document);
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);
    await draftRow(press, state, "max-tokens", "1024");

    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(state.settings?.draft.generation.maxTokens).toBe(1_024);
    expect(state.settings?.base.generation.maxTokens).toBe(4_096);
    expect(state.settings?.conflict?.armed).toBeFalse();

    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(state.settings?.conflict?.armed).toBeTrue();

    await selectRow(press, state, "default-author-brief");
    await press(key("return"));
    await press(key("N"));
    await press(key("s", { ctrl: true }));
    expect(state.mode).toBe("SETTINGS");
    expect(state.settings?.conflict?.armed).toBeFalse();
    await press(key("s"));
    expect(commands).toHaveLength(1);
    expect(state.settings?.conflict?.armed).toBeTrue();
    await press(key("s"));
    expect(commands).toHaveLength(2);
    expect(commands[1]!.mutationId).not.toBe(commands[0]!.mutationId);
    expect(state.settings?.draft.generation.maxTokens).toBe(1_024);
  });

  test("clears conflict state when an authoritative refresh matches the draft", async () => {
    const { source, state, press } = settingsHarness();
    let saves = 0;
    source.api.saveSettings = async () => {
      saves += 1;
      throw new Error("matching drafts must not save");
    };
    await openSettings(press);
    await draftRow(press, state, "max-tokens", "1024");
    const current = source.settingsView;
    if (!current.editable) throw new Error("demo settings must be editable");
    const document = applyBasicSettingsDraft(current.document, {
      ...state.settings!.draft.generation,
      maxTokens: 1_024
    });
    const converged: SettingsView = {
      ...current,
      stateGeneration: current.stateGeneration + 1,
      activeRevision: current.activeRevision + 1,
      document,
      effective: basicSettingsFromDocument(document),
      effectiveProse: basicSettingsFromDocument(document)
    };

    publishSettingsView(state, source, converged);

    expect(state.settings?.conflict).toBe(null);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
    await press(key("s"));
    expect(saves).toBe(0);
    expect(state.toast).toBe(null);
  });

  test("retries an unknown outcome and keeps newer row drafts", async () => {
    const { source, state, press } = settingsHarness();
    let current = source.settingsView;
    const commands: SaveSettingsCommand[] = [];
    source.api.saveSettings = async (command) => {
      commands.push(command);
      if (commands.length === 1) throw new Error("lost reply");
      if (!current.editable) throw new Error("demo settings must be editable");
      const effective = basicSettingsFromDocument(command.document);
      current = {
        ...current,
        stateGeneration: current.stateGeneration + 1,
        activeRevision: current.activeRevision + 1,
        document: command.document,
        effective
      };
      return {
        kind: "settings",
        settingsStateGeneration: current.stateGeneration,
        activeSettingsRevision: current.activeRevision,
        pendingSettingsRevision: null,
        activationOutcome: null
      };
    };
    source.api.getSettings = async () => current;
    await openSettings(press);
    await draftRow(press, state, "max-tokens", "1024");
    try {
      await press(key("s"));
    } catch (error) {
      expect((error as Error).message).toBe("lost reply");
    }
    await draftRow(press, state, "max-tokens", "512");
    await press(key("s"));

    expect(commands).toHaveLength(2);
    const { transportOperationId: firstTransport, ...firstDurable } = commands[0]!;
    const { transportOperationId: secondTransport, ...secondDurable } = commands[1]!;
    expect(secondDurable).toEqual(firstDurable);
    expect(secondTransport).not.toBe(firstTransport);
    expect(state.settings?.draft.generation.maxTokens).toBe(512);
    expect(state.toast).toBe("settings saved · newer edits kept");

    await press(key("s"));
    expect(commands).toHaveLength(3);
    expect(commands[2]!.mutationId).not.toBe(commands[1]!.mutationId);
    expect(state.settings?.draft.generation.maxTokens).toBe(512);
  });
});
