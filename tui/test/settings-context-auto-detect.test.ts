import { expect, test } from "bun:test";
import { settingsTextDraftWithSubscriptionPlan } from "../src/settings-text.js";
import { publishCurrentSettingsModelDiscovery } from "../src/settings-model-discovery.js";
import {
  deferred,
  draftRow,
  key,
  openSettings,
  selectRow,
  settingsHarness,
  settleBackend
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

// Regression test: cycling the model row with ←→ (cycleSettingsModel) is
// applySettingsModelChoice's fifth call site, and used to be the one call
// site settings-field-actions.ts's pasted-in probe calls never covered —
// typing an identifier probed, cycling silently did not. The seam in
// settingsOverlayAction now covers every path from one place.
test("cycling the model row with ←→ also triggers the auto-detect probe", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  let probeCalls = 0;
  const probeContextWindow = source.api.probeContextWindow;
  source.api.probeContextWindow = async (...args) => {
    probeCalls += 1;
    return probeContextWindow(...args);
  };
  await openSettings(press);
  const overlay = state.settings!;
  publishCurrentSettingsModelDiscovery(overlay, {
    observedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        remoteId: "model-a", name: "model-a",
        contextWindow: 32_768, maxOutputTokens: null, source: "openai-models"
      },
      {
        remoteId: "model-b", name: "model-b",
        contextWindow: null, maxOutputTokens: null, source: "openai-models"
      }
    ]
  });
  await selectRow(press, state, "model");

  // The current model ("novelist-a") is not in the discovered list, so the
  // first ← → step lands on index 0 — a known context window, no probe.
  await press(key("right"));
  expect(overlay.draft.generation.model).toBe("model-a");
  expect(probeCalls).toBe(0);

  // The second step reaches the model with no known context window.
  await press(key("right"));
  expect(overlay.draft.generation.model).toBe("model-b");
  await settleBackend(state, backend);

  expect(probeCalls).toBe(1);
  expect(overlay.draft.generation.contextWindow).toBe(32_768);
});

// Regression test: the C-15 picker column's commit (settingsModelPickerAction)
// is another of applySettingsModelChoice's call sites; the seam in
// settingsOverlayAction covers it the same way it covers typing and cycling.
test("choosing a model from the C-15 picker column also triggers the auto-detect probe", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  let probeCalls = 0;
  const probeContextWindow = source.api.probeContextWindow;
  source.api.probeContextWindow = async (...args) => {
    probeCalls += 1;
    return probeContextWindow(...args);
  };
  await openSettings(press);
  const overlay = state.settings!;
  // Past eight choices C-15 opens the option column instead of cycling.
  publishCurrentSettingsModelDiscovery(overlay, {
    observedAt: "2026-01-01T00:00:00.000Z",
    models: Array.from({ length: 9 }, (_, index) => ({
      remoteId: `model-${String(index + 1).padStart(2, "0")}`,
      name: `Model ${String(index + 1).padStart(2, "0")}`,
      contextWindow: null,
      maxOutputTokens: null,
      source: "openai-models" as const
    }))
  });

  await selectRow(press, state, "model");
  await press(key("return"));
  expect(overlay.modelPicker).not.toBe(null);
  overlay.modelPicker!.query = "model-03";
  await press(key("return"));

  expect(overlay.modelPicker).toBe(null);
  expect(overlay.draft.generation.model).toBe("model-03");
  await settleBackend(state, backend);

  expect(probeCalls).toBe(1);
});

// Regression test for the empty `catch {}` that used to swallow a probe
// failure: ECONNREFUSED, a TLS failure, a timeout, or the "selected profile
// no longer exists" invariant used to vanish silently after a model change,
// leaving the context window empty with no explanation. Both the automatic
// trigger and the manual `p` action must report the same failure.
test("a probe failure surfaces a visible warning on the context-window row after a model change", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.probeContextWindow = async () => {
    throw new Error("ECONNREFUSED");
  };

  await openSettings(press);
  await draftRow(press, state, "model", "gpt-5.9");
  await settleBackend(state, backend);

  expect(state.settings?.result).toEqual({
    state: "warning",
    message: "context probe failed · ECONNREFUSED"
  });
  expect(state.settings?.resultRow).toBe("context-window");
});

test("a probe failure from the manual p action reports the same warning", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  source.api.probeContextWindow = async () => {
    throw new Error("ECONNREFUSED");
  };

  await openSettings(press);
  await press(key("p"));

  expect(state.settings?.result).toEqual({
    state: "warning",
    message: "context probe failed · ECONNREFUSED"
  });
  expect(state.settings?.resultRow).toBe("context-window");
});

// Regression test for the orchestration fix: the automatic probe must not
// contend with ActionRuntime's single admission slot (action-runtime.ts).
// A probe deferred behind a genuinely busy runtime must neither interfere
// with the in-flight explicit action nor be lost — it has to run once the
// runtime frees up.
test("a probe deferred behind a busy runtime does not disturb the in-flight action, and still runs once idle", async () => {
  const { source, state, backend, press } = settingsHarness();
  configureNetworkSource(source);
  let probeCalls = 0;
  const probeContextWindow = source.api.probeContextWindow;
  source.api.probeContextWindow = async (...args) => {
    probeCalls += 1;
    return probeContextWindow(...args);
  };
  await openSettings(press);

  // Occupy the one exclusive backend slot with a stand-in for a genuine
  // user-initiated action, the same slot detectSettingsContext claims.
  const gate = deferred<void>();
  const holding = backend.run("saving settings", async () => {
    await gate.promise;
  });
  expect(state.backendTask?.label).toBe("saving settings");

  // Committing a model change while that slot is held must defer the probe
  // rather than fire it into the busy slot or drop it.
  await draftRow(press, state, "model", "gpt-5.9");
  expect(probeCalls).toBe(0);
  expect(state.backendTask?.label).toBe("saving settings");
  expect(state.toast).not.toContain("detecting context window");

  // Freeing the slot must let the deferred probe run — not lose it.
  gate.resolve();
  await holding;
  await settleBackend(state, backend);

  expect(probeCalls).toBe(1);
  expect(state.settings?.draft.generation).toMatchObject({
    model: "gpt-5.9",
    contextWindow: 32_768
  });
  expect(state.toast).not.toContain("busy");
});
