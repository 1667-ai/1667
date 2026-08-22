import { expect, test } from "bun:test";
import { INITIAL_SETTINGS_DOCUMENT_V5 } from "../../server/settings-v5-default.js";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type {
  SettingsView,
  SubscriptionAuthState
} from "../../shared/settings-v2-types.js";
import type { SettingsDocumentV5 } from "../../shared/settings-v5-types.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import { writingPromptSettingsFromAuthorBrief } from "../../shared/settings-v5-writing.js";
import { setComposerText } from "../src/composer-model.js";
import {
  publishCurrentSettingsModelDiscovery,
  settingsModelSelectionTargetIdentity
} from "../src/settings-model-discovery.js";
import { settingsDraftChanged } from "../src/settings-overlay-reconciliation.js";
import { settingsRows } from "../src/settings-overlay-model.js";
import { settingsProviderChoice } from "../src/settings-provider-choices.js";
import { settingsCursorRowIdentity } from "../src/settings-row-navigation.js";
import { settingsSubscriptionPreset } from "../src/settings-subscription.js";
import {
  deferred,
  key,
  openSettings,
  selectRow,
  settingsHarness as harness
} from "./settings-test-harness.js";

function initialSettingsView(
  subscriptionAuth: SubscriptionAuthState,
  activeRevision = 1,
  document: SettingsDocumentV5 = INITIAL_SETTINGS_DOCUMENT_V5,
  subscriptionAutoSelectEligible = true
): Extract<SettingsView, { dataFormat: 2 }> {
  const effective = basicSettingsFromDocument(document);
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: activeRevision,
    activeRevision,
    pendingRevision: null,
    document: document as never,
    effective,
    effectiveProse: effective,
    subscriptionAuth,
    subscriptionAutoSelectEligible,
    activeWriting: writingPromptSettingsFromAuthorBrief(effective.systemPrompt),
    lastActivationOutcome: null
  };
}

test("one signed-in plan becomes an unsaved provider draft", async () => {
  for (const fixture of [
    {
      provider: "chatgpt-plan" as const,
      auth: { chatgpt: "signed-in", claude: "signed-out" } as const
    },
    {
      provider: "claude-plan" as const,
      auth: { chatgpt: "signed-out", claude: "signed-in" } as const
    }
  ]) {
    const { source, state, press } = harness();
    source.settingsView = initialSettingsView(fixture.auth);
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);

    expect(settingsSubscriptionPreset(state.settings!)).toBe(fixture.provider);
    expect(settingsDraftChanged(state.settings!)).toBeTrue();
    expect(source.settingsView.effective.provider).toBe("dry-run");
    expect(source.settingsView.effective.apiKeyEnv).toBe(null);
    const providerHint = settingsRows(state.settings!, state.config)
      .find((row) => row.id === "provider")?.hint;
    expect(providerHint).toBe(fixture.provider === "chatgpt-plan"
      ? "ChatGPT plan is signed in. ChatGPT output length is best effort."
      : "Claude plan is signed in. Claude plan support is experimental.");
  }
});

// Regression test for the settings-view-mode dual-write: toggling `m` used
// to patch `overlay.draft.document` too, which `settingsDraftChanged`
// (a `JSON.stringify` comparison) reads as a real edit. A later refresh —
// signing into a plan is exactly that, a fresh `SettingsView` arriving
// after the overlay is already open — then saw `settingsDraftChanged(overlay)`
// true and `autoSelectSettingsSubscriptionPlan` refused to apply, so signing
// in silently stopped auto-selecting the plan. `m` now only ever changes
// `overlay.viewMode`, a config-backed session preference, never the draft.
test("toggling the view mode does not dirty the draft or block a later plan auto-select", async () => {
  const { source, state, press } = harness(undefined, { settingsViewMode: "simple" });
  source.settingsView = initialSettingsView({
    chatgpt: "signed-out",
    claude: "signed-out"
  });
  const entered = deferred<void>();
  const gate = deferred<SettingsView>();
  source.api.getSettings = async () => {
    entered.resolve();
    return gate.promise;
  };

  const opening = openSettings(press);
  await entered.promise;
  expect(state.settings!.viewMode).toBe("simple");
  await press(key("m"));
  expect(state.settings!.viewMode).toBe("advanced");
  expect(settingsDraftChanged(state.settings!)).toBeFalse();

  // The still-pending initial fetch resolves as a signed-in plan would look
  // to a background refresh landing after the overlay opened.
  gate.resolve(initialSettingsView({
    chatgpt: "signed-in",
    claude: "signed-out"
  }));
  await opening;

  expect(settingsSubscriptionPreset(state.settings!)).toBe("chatgpt-plan");
  expect(settingsDraftChanged(state.settings!)).toBeTrue();
  const providerHint = settingsRows(state.settings!, state.config)
    .find((row) => row.id === "provider")?.hint;
  expect(providerHint).toBe("ChatGPT plan is signed in. ChatGPT output length is best effort.");
});

test("both or neither signed-in plans leave the default provider untouched", async () => {
  for (const auth of [
    { chatgpt: "signed-in", claude: "signed-in" },
    { chatgpt: "signed-out", claude: "signed-out" }
  ] as const) {
    const { source, state, press } = harness();
    source.settingsView = initialSettingsView(auth);
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);

    expect(settingsSubscriptionPreset(state.settings!)).toBe(null);
    expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe("dry-run");
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
  }
});

test("cached signed-in auth does not create a draft before fresh settings arrive", async () => {
  const { source, state, press } = harness();
  source.settingsView = initialSettingsView({
    chatgpt: "signed-in",
    claude: "signed-out"
  });
  const fresh = initialSettingsView({
    chatgpt: "signed-out",
    claude: "signed-out"
  });
  source.api.getSettings = async () => fresh;

  await openSettings(press);

  expect(settingsSubscriptionPreset(state.settings!)).toBe(null);
  expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe("dry-run");
  expect(settingsDraftChanged(state.settings!)).toBeFalse();
});

test("a delayed settings refresh cannot select below an active inline edit", async () => {
  const { source, state, press } = harness();
  source.settingsView = initialSettingsView({
    chatgpt: "signed-out",
    claude: "signed-out"
  });
  const entered = deferred<void>();
  const gate = deferred<SettingsView>();
  source.api.getSettings = async () => {
    entered.resolve();
    return gate.promise;
  };

  const opening = openSettings(press);
  await entered.promise;
  await selectRow(press, state, "model");
  await press(key("return"));
  setComposerText(state.settings!.edit!.composer, "typed-before-refresh");
  gate.resolve(initialSettingsView({
    chatgpt: "signed-in",
    claude: "signed-out"
  }));
  await opening;

  expect(settingsSubscriptionPreset(state.settings!)).toBe(null);
  expect(state.settings!.edit?.composer.text).toBe("typed-before-refresh");
});

test("a delayed settings refresh keeps the selected row after auto-selection", async () => {
  const { source, state, press } = harness();
  source.settingsView = initialSettingsView({
    chatgpt: "signed-out",
    claude: "signed-out"
  });
  const entered = deferred<void>();
  const gate = deferred<SettingsView>();
  source.api.getSettings = async () => {
    entered.resolve();
    return gate.promise;
  };

  const opening = openSettings(press);
  await entered.promise;
  await selectRow(press, state, "model");
  expect(settingsCursorRowIdentity(state.settings!)).toBe("model");
  gate.resolve(initialSettingsView({
    chatgpt: "signed-in",
    claude: "signed-out"
  }));
  await opening;

  expect(settingsCursorRowIdentity(state.settings!)).toBe("model");
});

test("a delayed settings refresh cannot select below an open model picker", async () => {
  const { source, state, press } = harness();
  source.settingsView = initialSettingsView({
    chatgpt: "signed-out",
    claude: "signed-out"
  });
  const entered = deferred<void>();
  const gate = deferred<SettingsView>();
  const models = Array.from({ length: 9 }, (_, index) => ({
    remoteId: `model-${String(index + 1).padStart(2, "0")}`,
    name: `Model ${String(index + 1).padStart(2, "0")}`,
    contextWindow: 32_768,
    maxOutputTokens: null,
    source: "openai-models" as const
  }));
  source.api.getSettings = async () => {
    entered.resolve();
    return gate.promise;
  };

  const opening = openSettings(press);
  await entered.promise;
  const overlay = state.settings!;
  publishCurrentSettingsModelDiscovery(overlay, {
    observedAt: "2026-01-01T00:00:00.000Z",
    models
  });
  overlay.modelDiscoveryTargetIdentity = JSON.stringify([
    overlay.view.stateGeneration,
    JSON.stringify([
      overlay.draft.selectedProfileId,
      settingsModelSelectionTargetIdentity(overlay)
    ])
  ]);
  await selectRow(press, state, "model");
  await press(key("return"));
  expect(state.settings!.modelPicker).not.toBe(null);
  const picker = state.settings!.modelPicker;

  gate.resolve(initialSettingsView({
    chatgpt: "signed-in",
    claude: "signed-out"
  }));
  await opening;

  expect(state.settings!.modelPicker).toEqual(picker);
  expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe("dry-run");
});

test("a delayed settings refresh cannot select below nested Settings surfaces", async () => {
  for (const surface of ["sampling", "profile-transfer"] as const) {
    const { source, state, press } = harness();
    source.settingsView = initialSettingsView({
      chatgpt: "signed-out",
      claude: "signed-out"
    });
    const entered = deferred<void>();
    const gate = deferred<SettingsView>();
    source.api.getSettings = async () => {
      entered.resolve();
      return gate.promise;
    };

    const opening = openSettings(press);
    await entered.promise;
    await selectRow(press, state, surface === "sampling" ? "sampling" : "profile");
    await press(key(surface === "sampling" ? "return" : "i"));
    const before = surface === "sampling"
      ? state.settings!.sampling
      : state.settings!.profileTransfer;
    expect(before).not.toBe(null);

    gate.resolve(initialSettingsView({
      chatgpt: "signed-in",
      claude: "signed-out"
    }));
    await opening;

    expect(surface === "sampling"
      ? state.settings!.sampling
      : state.settings!.profileTransfer).toEqual(before);
    expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe("dry-run");
  }
});

test("a pending activation keeps the pristine provider untouched", async () => {
  const { source, state, press } = harness();
  source.settingsView = {
    ...initialSettingsView(
      { chatgpt: "signed-in", claude: "signed-out" },
      1,
      INITIAL_SETTINGS_DOCUMENT_V5,
      false
    ),
    pendingRevision: 2
  };
  source.api.getSettings = async () => source.settingsView;

  await openSettings(press);

  expect(settingsSubscriptionPreset(state.settings!)).toBe(null);
  expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe("dry-run");
  expect(settingsDraftChanged(state.settings!)).toBeFalse();
});

test("a saved provider, API key, or local route is never replaced", async () => {
  const initial = basicSettingsFromDocument(INITIAL_SETTINGS_DOCUMENT_V5);
  const saved = [
    {
      choice: "openai",
      document: applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V5, {
        ...initial,
        provider: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.4",
        apiKeyEnv: "OPENAI_API_KEY",
        contextWindow: null
      })
    },
    {
      choice: "ollama",
      document: applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V5, {
        ...initial,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.2",
        apiKeyEnv: null,
        contextWindow: null
      })
    },
    {
      // The document still has the checked-in default shape. Revision 2
      // proves that a writer explicitly saved the default provider.
      choice: "dry-run",
      document: INITIAL_SETTINGS_DOCUMENT_V5
    }
  ] as const;

  for (const fixture of saved) {
    const { source, state, press } = harness();
    source.settingsView = initialSettingsView(
      { chatgpt: "signed-in", claude: "signed-out" },
      2,
      fixture.document,
      false
    );
    source.api.getSettings = async () => source.settingsView;

    await openSettings(press);

    expect(settingsProviderChoice(
      state.settings!.draft.generation,
      selectSettingsRoute(
        state.settings!.draft.document!,
        "default"
      ).connection.preset
    ).id).toBe(fixture.choice);
    expect(settingsSubscriptionPreset(state.settings!)).toBe(null);
    expect(settingsDraftChanged(state.settings!)).toBeFalse();
  }
});
