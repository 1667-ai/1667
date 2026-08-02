import { describe, expect, test } from "bun:test";
import { applyBasicSettingsDraft } from "../../shared/settings-basic-draft.js";
import type {
  ModelDiscoveryResultV2,
  SettingsView
} from "../../shared/settings-v2-types.js";
import { setComposerText } from "../src/composer-model.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import {
  deferred,
  draftRow,
  generationFromProbeTarget,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

describe("Settings model picker", () => {
  test("reads provider models, cycles them, and accepts a custom name", async () => {
    const { source, state, cache, press } = settingsHarness();
    if (!source.settingsView.editable) {
      throw new Error("demo settings must be editable");
    }
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
    expect(state.settings?.draft.generation).toMatchObject({
      model: "private-preview-model",
      contextWindow: null
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
    await draftRow(press, state, "api-key", "replacement-secret");
    gate.resolve(discovery("stale-model"));
    await opening;

    expect(calls).toBe(2);
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
    if (!source.settingsView.editable) {
      throw new Error("demo settings must be editable");
    }
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

function configureNetworkSource(
  source: ReturnType<typeof settingsHarness>["source"]
): void {
  if (!source.settingsView.editable) {
    throw new Error("demo settings must be editable");
  }
  const settings = {
    ...source.settings,
    provider: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    model: "novelist-a",
    apiKeyEnv: "OPENAI_API_KEY"
  };
  const document = applyBasicSettingsDraft(
    source.settingsView.document,
    settings
  );
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
