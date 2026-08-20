import { expect, test } from "bun:test";
import { settingsTextDraftWithSubscriptionPlan } from "../src/settings-text.js";
import {
  deferred,
  draftRow,
  openSettings,
  settingsHarness
} from "./settings-test-harness.js";
import { configureNetworkSource } from "./settings-model-provenance-test-helpers.js";

test("committing a model change sets the context window automatically", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  let probeCalls = 0;
  const probeContextWindow = source.api.probeContextWindow;
  source.api.probeContextWindow = async (...args) => {
    probeCalls += 1;
    return probeContextWindow(...args);
  };
  await openSettings(press);

  await draftRow(press, state, "model", "gpt-5.9");
  // The probe runs in the background so the commit itself never blocks;
  // wait for it to settle before reading the result it lands.
  await backend.whenIdle();

  expect(probeCalls).toBe(1);
  expect(state.settings?.draft.generation).toMatchObject({
    model: "gpt-5.9",
    contextWindow: 32_768
  });
  expect(state.settings?.probing).toBeFalse();
});

test("a manually entered context window is not overwritten by a model change probe that resolves late", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  const entered = deferred<void>();
  const gate = deferred<{ contextWindow: number | null }>();
  source.api.probeContextWindow = async () => {
    entered.resolve();
    return gate.promise;
  };
  await openSettings(press);

  const committing = draftRow(press, state, "model", "gpt-5.9");
  await entered.promise;
  expect(state.settings?.probing).toBeTrue();

  await draftRow(press, state, "context-window", "12345");
  gate.resolve({ contextWindow: 65_536 });
  await committing;

  expect(state.settings?.draft.generation).toMatchObject({
    model: "gpt-5.9",
    contextWindow: 12_345
  });
});

test("a fixed subscription connection reports the manual-entry warning instead of probing after a model change", async () => {
  const { source, state, press } = settingsHarness();
  await openSettings(press);
  const overlay = state.settings!;
  overlay.view = {
    ...overlay.view,
    subscriptionAuth: { chatgpt: "signed-in", claude: "signed-out" }
  };
  overlay.draft = settingsTextDraftWithSubscriptionPlan(overlay.draft, "chatgpt-plan", {
    ...overlay.draft.generation,
    provider: "openai-compatible",
    baseUrl: "",
    model: "gpt-5.4",
    apiKeyEnv: null,
    contextWindow: 272_000
  });
  overlay.base = overlay.draft;
  let probeCalls = 0;
  const probeContextWindow = source.api.probeContextWindow;
  source.api.probeContextWindow = async (...args) => {
    probeCalls += 1;
    return probeContextWindow(...args);
  };

  await draftRow(press, state, "model", "gpt-5.5");

  expect(probeCalls).toBe(0);
  expect(overlay.result?.state).toBe("warning");
  expect(overlay.result?.message).toContain("ChatGPT plan is signed in.");
  expect(overlay.result?.message).toContain("Enter context size manually.");
  expect(overlay.resultRow).toBe("context-window");
});

test("a model change that resolves to an already-known context window is not probed", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.discoverModels = async () => ({
    observedAt: "2026-01-01T00:00:00.000Z",
    models: [{
      remoteId: "known-model",
      name: "known-model",
      contextWindow: 65_536,
      maxOutputTokens: null,
      source: "openai-models"
    }]
  });
  let probeCalls = 0;
  const probeContextWindow = source.api.probeContextWindow;
  source.api.probeContextWindow = async (...args) => {
    probeCalls += 1;
    return probeContextWindow(...args);
  };

  await openSettings(press);
  // The single discovered choice auto-fills once the typed model is cleared
  // (applyCachedSettingsModelChoice), landing the known context window
  // synchronously before the auto-probe guard ever runs.
  await draftRow(press, state, "model", "");

  expect(state.settings?.draft.generation).toMatchObject({
    model: "known-model",
    contextWindow: 65_536
  });
  expect(probeCalls).toBe(0);
});
