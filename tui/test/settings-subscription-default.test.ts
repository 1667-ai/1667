import { expect, test } from "bun:test";
import { INITIAL_SETTINGS_DOCUMENT_V2 } from "../../server/settings-v2-default.js";
import {
  applyBasicSettingsDraft,
  basicSettingsFromDocument
} from "../../shared/settings-basic-draft.js";
import type {
  SettingsDocumentV2,
  SettingsView,
  SubscriptionAuthState
} from "../../shared/settings-v2-types.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import { settingsDraftChanged } from "../src/settings-overlay-reconciliation.js";
import { settingsRows } from "../src/settings-overlay-model.js";
import { settingsProviderChoice } from "../src/settings-provider-choices.js";
import { settingsSubscriptionPreset } from "../src/settings-subscription.js";
import {
  openSettings,
  settingsHarness as harness
} from "./settings-test-harness.js";

function initialSettingsView(
  subscriptionAuth: SubscriptionAuthState,
  activeRevision = 1,
  document: SettingsDocumentV2 = INITIAL_SETTINGS_DOCUMENT_V2
): Extract<SettingsView, { dataFormat: 2 }> {
  const effective = basicSettingsFromDocument(document);
  return {
    dataFormat: 2,
    editable: true,
    stateGeneration: activeRevision,
    activeRevision,
    pendingRevision: null,
    document,
    effective,
    effectiveProse: effective,
    subscriptionAuth,
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

test("a pending activation keeps the pristine provider untouched", async () => {
  const { source, state, press } = harness();
  source.settingsView = {
    ...initialSettingsView({ chatgpt: "signed-in", claude: "signed-out" }),
    pendingRevision: 2
  };
  source.api.getSettings = async () => source.settingsView;

  await openSettings(press);

  expect(settingsSubscriptionPreset(state.settings!)).toBe(null);
  expect(settingsProviderChoice(state.settings!.draft.generation).id).toBe("dry-run");
  expect(settingsDraftChanged(state.settings!)).toBeFalse();
});

test("a saved provider, API key, or local route is never replaced", async () => {
  const initial = basicSettingsFromDocument(INITIAL_SETTINGS_DOCUMENT_V2);
  const saved = [
    {
      choice: "openai",
      document: applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
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
      document: applyBasicSettingsDraft(INITIAL_SETTINGS_DOCUMENT_V2, {
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
      document: INITIAL_SETTINGS_DOCUMENT_V2
    }
  ] as const;

  for (const fixture of saved) {
    const { source, state, press } = harness();
    source.settingsView = initialSettingsView(
      { chatgpt: "signed-in", claude: "signed-out" },
      2,
      fixture.document
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
