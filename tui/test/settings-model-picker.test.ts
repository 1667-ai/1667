import { describe, expect, test } from "bun:test";
import {
  applyBasicModelDiscovery,
  applyBasicSettingsDraft
} from "../../shared/settings-basic-draft.js";
import { createFailureEnvelope } from "../../shared/failure-envelope.js";
import type {
  ModelDiscoveryResultV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { setComposerText } from "../src/composer-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { WorkerApiError } from "../src/worker-api.js";
import { settingsModelSelectionTargetIdentity } from "../src/settings-model-discovery.js";
import {
  deferred,
  draftRow,
  generationFromProbeTarget,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import { configureNetworkSource } from "./settings-model-provenance-test-helpers.js";

describe("Settings model picker", () => {
  test("invalid provider drafts keep distinct discovery identities", async () => {
    const { source, state, press } = settingsHarness();
    configureNetworkSource(source);

    await openSettings(press);
    state.settings!.viewMode = "advanced";
    await draftRow(press, state, "base-url", "not-a-url");
    const first = settingsModelSelectionTargetIdentity(state.settings!);
    await draftRow(press, state, "base-url", "still-not-a-url");

    expect(settingsModelSelectionTargetIdentity(state.settings!)).not.toBe(first);
  });

  test("reads provider models, cycles them, and accepts a custom name", async () => {
    const { source, state, cache, press, backend } = settingsHarness();
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    const document = applyBasicSettingsDraft(source.settingsView.document, {
      ...source.settings,
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "novelist-a",
      apiKeyEnv: "OPENAI_API_KEY",
      contextWindow: 32_768
    });
    const view: SettingsView = {
      ...source.settingsView,
      document,
      effective: {
        ...source.settings,
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "novelist-a",
        apiKeyEnv: "OPENAI_API_KEY",
        contextWindow: 32_768
      },
      effectiveProse: {
        ...source.settings,
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "novelist-a",
        apiKeyEnv: "OPENAI_API_KEY",
        contextWindow: 32_768
      }
    };
    source.settingsView = view;
    source.settings = view.effective;
    source.api.getSettings = async () => view;
    const discoveryTargets: string[] = [];
    source.api.discoverModels = async (target) => {
      discoveryTargets.push(generationFromProbeTarget(target).baseUrl);
      return {
        observedAt: "2026-01-01T00:00:00.000Z",
        models: [
          {
            remoteId: "novelist-a",
            name: "Novelist A",
            contextWindow: 32_768,
            maxOutputTokens: 8_192,
            source: "openai-models"
          },
          {
            remoteId: "novelist-b",
            name: "Novelist B",
            contextWindow: 65_536,
            maxOutputTokens: 16_384,
            source: "openai-models"
          }
        ]
      };
    };

    await openSettings(press);
    state.settings!.viewMode = "advanced";

    expect(discoveryTargets).toEqual(["https://api.openai.com/v1"]);
    expect(state.settings?.draft.cachePolicy).toBe("off");
    await selectRow(press, state, "model");
    let rendered = frameText(renderStoryScreen(
      state,
      { width: 100, height: 30, wrapCache: cache }
    ).lines);
    expect(rendered).toContain("‹ Novelist A ›");
    // C-07 keeps the identifier in the hint column, not inside the chip.
    expect(rendered).toContain("novelist-a · 1 of 2");
    expect(rendered).toContain("←→ choose · ↵ custom");
    expect(rendered).not.toContain("cache policy");

    await press(key("right"));
    expect(state.settings?.draft.generation).toMatchObject({
      model: "novelist-b",
      contextWindow: 65_536
    });
    await press(key("left"));
    expect(state.settings?.draft.generation).toMatchObject({
      model: "novelist-a",
      contextWindow: 32_768
    });

    await press(key("return"));
    expect(state.settings?.edit?.row).toBe("model");
    setComposerText(state.settings!.edit!.composer, "private-preview-model");
    await press(key("return"));
    // The commit clears the stale value synchronously, then a background
    // probe (unmocked here, so it uses the demo's default reading) lands
    // automatically.
    await backend.whenIdle();
    expect(state.settings?.draft.generation).toMatchObject({
      model: "private-preview-model",
      contextWindow: 32_768
    });
    rendered = frameText(renderStoryScreen(
      state,
      { width: 100, height: 30, wrapCache: cache }
    ).lines);
    // The hint carries the identifier the chip truncated, with no position —
    // this model is not one the provider listed.
    expect(rendered).toContain("private-preview-model");

    await press(key("left"));
    expect(state.settings?.draft.generation).toMatchObject({
      model: "novelist-b",
      contextWindow: 65_536
    });
  });

  test("retries the latest model list after an in-flight list settles", async () => {
    const { source, state, backend, press } = settingsHarness();
    configureNetworkSource(source);
    const firstEntered = deferred<void>();
    const firstGate = deferred<ModelDiscoveryResultV2>();
    const secondEntered = deferred<void>();
    const secondGate = deferred<ModelDiscoveryResultV2>();
    let calls = 0;
    source.api.discoverModels = async () => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        return firstGate.promise;
      }
      secondEntered.resolve();
      return secondGate.promise;
    };

    const opening = openSettings(press);
    await firstEntered.promise;
    await draftRow(
      press,
      state,
      "base-url",
      "https://models.example.test/v1"
    );
    firstGate.resolve(discovery("old-model"));
    await opening;
    await secondEntered.promise;
    secondGate.resolve(discovery("current-model"));
    await backend.whenIdle();

    expect(calls).toBe(2);
    expect(state.settings?.modelDiscovery?.models[0]?.remoteId)
      .toBe("current-model");
  });

  test("selects the only model returned for an unsaved connection draft", async () => {
    const { source, state, backend, press } = settingsHarness();
    configureNetworkSource(source);
    const targets: string[] = [];
    source.api.discoverModels = async (target) => {
      const baseUrl = generationFromProbeTarget(target).baseUrl;
      targets.push(baseUrl);
      return discovery(baseUrl === "https://models.example.test/v1"
        ? "loaded-local-model"
        : "novelist-a");
    };

    await openSettings(press);
    state.settings!.viewMode = "advanced";
    await draftRow(press, state, "model", "");
    expect(state.settings?.draft.generation.model).toBe("novelist-a");
    await draftRow(
      press,
      state,
      "base-url",
      "https://models.example.test/v1"
    );
    await backend.whenIdle();

    expect(targets.at(-1)).toBe("https://models.example.test/v1");
    expect(state.settings?.draft.generation.model).toBe("loaded-local-model");
    expect(state.settings?.view.effective.model).toBe("novelist-a");
  });

  test("refreshes an automatic model but preserves a typed model", async () => {
    const { source, state, backend, press } = settingsHarness();
    configureNetworkSource(source);
    source.api.discoverModels = async (target) => {
      const host = new URL(generationFromProbeTarget(target).baseUrl).hostname;
      return discovery(`model-${host.split(".")[0]}`);
    };

    await openSettings(press);
    state.settings!.viewMode = "advanced";
    await draftRow(press, state, "model", "");
    await draftRow(press, state, "base-url", "https://alpha.example.test/v1");
    await backend.whenIdle();
    expect(state.settings?.draft.generation.model).toBe("model-alpha");
    await selectRow(press, state, "profile");
    await press(key("e"));
    setComposerText(state.settings!.edit!.composer, "Renamed Profile");
    await press(key("return"));
    const alphaProfileId = state.settings?.draft.selectedProfileId;
    await press(key("N"));
    await press(key("left"));
    expect(state.settings?.draft.selectedProfileId).toBe(alphaProfileId);

    const original = source.settingsView;
    if (!original.editable) throw new Error("demo settings must be editable");
    const refreshedSettings = { ...original.effective, maxTokens: 4_096 };
    const refreshed: SettingsView = {
      ...original,
      stateGeneration: original.stateGeneration + 1,
      activeRevision: original.activeRevision + 1,
      document: applyBasicSettingsDraft(original.document, refreshedSettings),
      effective: refreshedSettings,
      effectiveProse: refreshedSettings
    };
    source.api.saveSettings = async () => {
      source.settingsView = refreshed;
      throw new WorkerApiError(createFailureEnvelope({
        code: "revision_conflict",
        message: "Settings changed since this edit began.",
        status: 409
      }));
    };
    source.api.getSettings = async () => source.settingsView;
    await press(key("s"));
    expect(state.settings?.draft.generation.model).toBe("model-alpha");

    await draftRow(press, state, "base-url", "https://beta.example.test/v1");
    await backend.whenIdle();
    expect(state.settings?.draft.generation.model).toBe("model-beta");

    await draftRow(press, state, "model", "writer-model");
    await draftRow(press, state, "base-url", "https://gamma.example.test/v1");
    await backend.whenIdle();
    expect(state.settings?.draft.generation.model).toBe("writer-model");
  });

  test("does not select a model in read-only legacy settings", async () => {
    const { source, state, press } = settingsHarness();
    configureNetworkSource(source);
    source.settings = { ...source.settings, model: "" };
    const view: SettingsView = {
      dataFormat: 1,
      editable: false,
      stateGeneration: null,
      activeRevision: null,
      pendingRevision: null,
      document: null,
      effective: source.settings,
      effectiveProse: source.settings,
      lastActivationOutcome: null
    };
    source.settingsView = view;
    source.api.getSettings = async () => view;
    source.api.discoverModels = async () => discovery("loaded-local-model");

    await openSettings(press);
    state.settings!.viewMode = "advanced";

    expect(state.settings?.modelDiscovery?.models[0]?.remoteId)
      .toBe("loaded-local-model");
    expect(state.settings?.draft.generation.model).toBe("");
  });

  test("preserves a context edit while selecting a late model", async () => {
    const { source, state, press } = settingsHarness();
    configureNetworkSource(source);
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    source.settings = {
      ...source.settings,
      contextWindow: null
    };
    source.settingsView = {
      ...source.settingsView,
      document: applyBasicSettingsDraft(
        source.settingsView.document,
        source.settings
      ),
      effective: source.settings,
      effectiveProse: source.settings
    };
    source.api.getSettings = async () => source.settingsView;
    const entered = deferred<void>();
    const gate = deferred<ModelDiscoveryResultV2>();
    let calls = 0;
    source.api.discoverModels = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ...discovery("first-model"),
          models: ["first-model", "second-model"].map((id) => discovery(id).models[0]!)
        };
      }
      entered.resolve();
      return gate.promise;
    };

    await openSettings(press);
    state.settings!.viewMode = "advanced";
    await draftRow(press, state, "model", "");
    await draftRow(press, state, "context-window", "12345");
    expect(state.settings?.draft.generation.contextWindow).toBe(12_345);
    const changingTarget = draftRow(press, state, "api-key", "replacement-secret");
    await entered.promise;
    state.settings!.conflict = { message: "Settings changed", armed: true };
    gate.resolve(discoveryWithContext("loaded-local-model", 65_536));
    await changingTarget;

    expect(state.settings?.draft.generation).toMatchObject({
      model: "loaded-local-model",
      contextWindow: 12_345
    });
    expect(state.settings?.conflict?.armed).toBeFalse();
  });

  test("uses discovered context after clearing a model in flight", async () => {
    const { source, state, press } = settingsHarness();
    configureNetworkSource(source);
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    source.settings = { ...source.settings, contextWindow: 32_768 };
    const view: SettingsView = {
      ...source.settingsView,
      document: applyBasicModelDiscovery(
        source.settingsView.document,
        discoveryWithContext("novelist-a", 32_768),
        32_768
      ),
      effective: source.settings,
      effectiveProse: source.settings
    };
    source.settingsView = view;
    source.api.getSettings = async () => view;
    const entered = deferred<void>();
    const gate = deferred<ModelDiscoveryResultV2>();
    source.api.discoverModels = async () => {
      entered.resolve();
      return gate.promise;
    };

    const opening = openSettings(press);
    await entered.promise;
    await draftRow(press, state, "model", "");
    expect(state.settings?.draft.generation.contextWindow).toBe(null);
    gate.resolve(discoveryWithContext("loaded-local-model", 65_536));
    await opening;

    expect(state.settings?.draft.generation).toMatchObject({
      model: "loaded-local-model",
      contextWindow: 65_536
    });
  });

  test("an API key edit invalidates an in-flight model list", async () => {
    const { source, state, press } = settingsHarness();
    configureNetworkSource(source);
    const entered = deferred<void>();
    const gate = deferred<ModelDiscoveryResultV2>();
    let calls = 0;
    source.api.discoverModels = async () => {
      calls += 1;
      if (calls > 1) {
        throw new Error("credential target must be saved");
      }
      entered.resolve();
      return gate.promise;
    };

    const opening = openSettings(press);
    await entered.promise;
    await draftRow(press, state, "model", "");
    await draftRow(press, state, "api-key", "replacement-secret");
    gate.resolve(discovery("stale-model"));
    await opening;

    expect(calls).toBe(2);
    expect(state.settings?.draft.generation.model).toBe("");
    expect(state.settings?.modelDiscovery).toBe(null);
    expect(state.settings?.discoveringModels).toBeFalse();
  });

  test("closing Settings cancels an in-flight model list", async () => {
    const { source, state, backend, press } = settingsHarness();
    configureNetworkSource(source);
    const entered = deferred<void>();
    let aborted = false;
    source.api.discoverModels = async (_target, signal) => {
      entered.resolve();
      return await new Promise<ModelDiscoveryResultV2>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    };

    const opening = openSettings(press);
    await entered.promise;
    await press(key("escape"));
    await opening;

    expect(aborted).toBeTrue();
    expect(state.settings).toBe(null);
    expect(await backend.whenIdle()).toBeTrue();
  });

  test("one discovered model preserves a manual context window", async () => {
    const { source, state, press } = settingsHarness();
    configureNetworkSource(source);
    if (!source.settingsView.editable) throw new Error("demo settings must be editable");
    source.settings = { ...source.settings, contextWindow: 32_768 };
    source.settingsView = {
      ...source.settingsView,
      document: applyBasicSettingsDraft(
        source.settingsView.document,
        source.settings
      ),
      effective: source.settings,
      effectiveProse: source.settings
    };
    source.api.getSettings = async () => source.settingsView;
    source.api.discoverModels = async () => discovery("novelist-a");

    await openSettings(press);
    state.settings!.viewMode = "advanced";
    await selectRow(press, state, "model");
    await press(key("right"));

    expect(state.settings?.draft.generation).toMatchObject({
      model: "novelist-a",
      contextWindow: 32_768
    });
  });

  test("an unchanged blank API key keeps discovered models", async () => {
    const { source, state, press } = settingsHarness();
    configureNetworkSource(source);
    source.api.discoverModels = async () => discovery("novelist-a");
    await openSettings(press);
    state.settings!.viewMode = "advanced";
    const discoveryResult = state.settings?.modelDiscovery;

    await draftRow(press, state, "api-key", "");

    expect(state.settings?.modelDiscovery).toBe(discoveryResult);
    expect(state.settings?.discoveringModels).toBeFalse();
  });
});

function discovery(remoteId: string): ModelDiscoveryResultV2 {
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
}

function discoveryWithContext(remoteId: string, contextWindow: number): ModelDiscoveryResultV2 {
  const result = discovery(remoteId);
  return { ...result, models: [{ ...result.models[0]!, contextWindow }] };
}
