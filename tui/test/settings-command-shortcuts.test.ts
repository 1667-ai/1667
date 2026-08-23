import { expect, test } from "bun:test";
import { basicSettingsFromDocument } from "../../shared/settings-basic-draft.js";
import { writingPromptSettingsFromAuthorBrief } from "../../shared/settings-v5-writing.js";
import { selectSettingsRoute } from "../../shared/settings-route.js";
import type { SettingsView } from "../../shared/settings-v2-types.js";
import {
  settingsTextDraftForView,
  settingsTextDraftWithGeneration,
  settingsTextDraftWithSubscriptionPlan
} from "../src/settings-text.js";
import { samplingLayerRowIndex } from "../src/sampling-model.js";
import { settingsCursorRowIdentity } from "../src/settings-row-navigation.js";
import { deferred, settingsHarness, key } from "./settings-test-harness.js";

/** Type through the real Ctrl+P route and accept the exact named destination. */
async function choosePaletteCommand(
  harness: ReturnType<typeof settingsHarness>,
  query: string,
  commandId: string
): Promise<void> {
  const { press, state } = harness;
  await press(key("p", { ctrl: true }));
  expect(state.mode).toBe("COMMANDS");
  for (const character of query) {
    await press(key(character, { sequence: character }));
  }
  expect(state.commands?.selectedId).toBe(commandId);
  await press(key("return"));
}

function chatgptPlanView(current: SettingsView): SettingsView {
  if (!current.editable) throw new Error("demo Settings fixture must be editable");
  const draft = settingsTextDraftForView(current);
  const planDraft = settingsTextDraftWithSubscriptionPlan(
    draft,
    "chatgpt-plan",
    {
      ...draft.generation,
      provider: "openai-compatible",
      baseUrl: "",
      apiKeyEnv: null,
      model: "gpt-5.4",
      contextWindow: 272_000
    }
  );
  if (planDraft.document === null) throw new Error("subscription draft has no document");
  const effective = basicSettingsFromDocument(planDraft.document);
  return {
    ...current,
    subscriptionAuth: { chatgpt: "signed-in", claude: "signed-out" },
    document: planDraft.document,
    effective,
    effectiveProse: basicSettingsFromDocument(
      planDraft.document,
      selectSettingsRoute(planDraft.document, "prose").profileId
    ),
    activeWriting: writingPromptSettingsFromAuthorBrief(effective.systemPrompt)
  };
}

test("Ctrl+P opens the Provider, Model, and Default Author Brief rows", async () => {
  for (const [query, row] of [
    ["provider", "provider"],
    ["model", "model"],
    ["default authors note", "default-author-brief"]
  ] as const) {
    const harness = settingsHarness();
    await choosePaletteCommand(harness, query, `setting:${row}`);
    expect(harness.state.mode).toBe("SETTINGS");
    expect(settingsCursorRowIdentity(harness.state.settings!)).toBe(row);
  }
});

test("an Advanced Settings shortcut expands only its overlay", async () => {
  const harness = settingsHarness(undefined, { settingsViewMode: "simple" });
  await choosePaletteCommand(harness, "effort", "setting:effort");

  expect(harness.state.settings?.viewMode).toBe("advanced");
  expect(harness.state.config.settingsViewMode).toBe("simple");
  expect(harness.source.config.settingsViewMode).toBe("simple");
  expect(settingsCursorRowIdentity(harness.state.settings!)).toBe("effort");
});

test("Ctrl+P reaches an Advanced-only writing prompt row", async () => {
  const harness = settingsHarness(undefined, { settingsViewMode: "simple" });
  await choosePaletteCommand(harness, "rewrite guidance", "setting:rewrite-guidance");

  expect(harness.state.settings?.viewMode).toBe("advanced");
  expect(settingsCursorRowIdentity(harness.state.settings!)).toBe("rewrite-guidance");
});

test("a Sampling shortcut opens the nested panel at its canonical row", async () => {
  const harness = settingsHarness();
  await choosePaletteCommand(harness, "sampling top p", "setting:sampling:scalar:topP");

  expect(harness.state.mode).toBe("SETTINGS");
  expect(harness.state.settings?.sampling?.panel).toBe("sampling");
  expect(harness.state.settings?.sampling?.cursor).toBe(samplingLayerRowIndex("topP"));
  expect(harness.state.settings?.sampling?.biasResolution.kind).toBeDefined();
});

test("a Sampling shortcut survives an authoritative Settings refresh", async () => {
  const harness = settingsHarness();
  const current = harness.source.settingsView;
  if (!current.editable) throw new Error("demo Settings fixture must be editable");
  const nextDraft = settingsTextDraftWithGeneration(
    settingsTextDraftForView(current),
    { ...current.effective, maxTokens: current.effective.maxTokens + 1 }
  );
  if (nextDraft.document === null) throw new Error("refreshed draft has no document");
  const effective = basicSettingsFromDocument(nextDraft.document);
  harness.source.api.getSettings = async () => ({
    ...current,
    stateGeneration: current.stateGeneration + 1,
    activeRevision: current.activeRevision + 1,
    document: nextDraft.document!,
    effective,
    effectiveProse: basicSettingsFromDocument(
      nextDraft.document!,
      selectSettingsRoute(nextDraft.document!, "prose").profileId
    )
  });

  await choosePaletteCommand(harness, "sampling top p", "setting:sampling:scalar:topP");

  expect(harness.state.settings?.sampling?.panel).toBe("sampling");
  expect(harness.state.settings?.sampling?.cursor).toBe(samplingLayerRowIndex("topP"));
});

test("unavailable provider rows report the destination and focus Provider", async () => {
  for (const [query, commandId, label] of [
    ["base URL", "setting:base-url", "base URL"],
    ["plain HTTP", "setting:allow-insecure-http", "plain HTTP"]
  ] as const) {
    const harness = settingsHarness(undefined, { settingsViewMode: "simple" });
    harness.source.settingsView = chatgptPlanView(harness.source.settingsView);
    harness.source.api.getSettings = async () => harness.source.settingsView;

    await choosePaletteCommand(harness, query, commandId);

    expect(harness.state.settings?.viewMode).toBe("simple");
    expect(settingsCursorRowIdentity(harness.state.settings!)).toBe("provider");
    expect(harness.state.toast).toBe(`${label} is unavailable for the selected provider`);
  }
});

test("a refreshed subscription provider keeps an unavailable target in Simple view", async () => {
  const harness = settingsHarness(undefined, { settingsViewMode: "simple" });
  const refreshed = chatgptPlanView(harness.source.settingsView);
  harness.source.api.getSettings = async () => refreshed;

  await choosePaletteCommand(harness, "plain HTTP", "setting:allow-insecure-http");

  expect(harness.state.settings?.viewMode).toBe("simple");
  expect(settingsCursorRowIdentity(harness.state.settings!)).toBe("provider");
  expect(harness.state.toast).toBe("plain HTTP is unavailable for the selected provider");
});

test("a Settings target opens while another backend task is busy", async () => {
  const harness = settingsHarness(undefined, { settingsViewMode: "simple" });
  const gate = deferred<void>();
  const busy = harness.backend.run("generating prose", async () => gate.promise);

  await choosePaletteCommand(harness, "effort", "setting:effort");
  gate.resolve();
  expect(await busy).toBe(true);

  expect(harness.state.settings?.viewMode).toBe("advanced");
  expect(settingsCursorRowIdentity(harness.state.settings!)).toBe("effort");
});
