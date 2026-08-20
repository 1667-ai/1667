import { expect, test } from "bun:test";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import { SETTINGS_ROW_IDS, settingsRowIds } from "../src/settings-row-navigation.js";
import { settingsCursorRowIdentity } from "../src/settings-row-navigation.js";
import { settingsTextDraftWithSubscriptionPlan } from "../src/settings-text.js";
import {
  installSave,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import { configureNetworkSource } from "./settings-model-provenance-test-helpers.js";

test("simple mode shows only the intended rows, and advanced mode shows every row unchanged", async () => {
  const { state, press } = settingsHarness();
  await openSettings(press);
  const overlay = state.settings!;

  // Default demo settings use dry-run, so base-url/api-key stay visible in
  // simple mode too — they are hidden only by the fixed-subscription rule.
  expect(settingsRowIds(overlay)).toEqual([
    "system-prompt", "provider", "base-url", "api-key", "model", "context-window"
  ]);

  await press(key("m"));

  expect(settingsRowIds(overlay)).toEqual([...SETTINGS_ROW_IDS]);
});

test("base-url and api-key stay visible in simple mode until a fixed subscription connection hides them", async () => {
  const { source, state, press } = settingsHarness();
  configureNetworkSource(source);
  await openSettings(press);
  const overlay = state.settings!;

  expect(settingsRowIds(overlay)).toContain("base-url");
  expect(settingsRowIds(overlay)).toContain("api-key");

  overlay.draft = settingsTextDraftWithSubscriptionPlan(overlay.draft, "chatgpt-plan", {
    ...overlay.draft.generation,
    provider: "openai-compatible",
    baseUrl: "",
    model: "gpt-5.4",
    apiKeyEnv: null
  });

  expect(settingsRowIds(overlay).includes("base-url")).toBeFalse();
  expect(settingsRowIds(overlay).includes("api-key")).toBeFalse();
});

test("toggling the view mode preserves the cursor by row identity and never parks it on a hidden row", async () => {
  const { state, press } = settingsHarness();
  await openSettings(press);
  const overlay = state.settings!;

  await selectRow(press, state, "model");
  await press(key("m"));
  expect(settingsCursorRowIdentity(overlay)).toBe("model");
  expect(settingsRowIds(overlay)[overlay.cursor]).toBe("model");

  // "theme" only exists in advanced mode. Flipping back to simple must not
  // leave the cursor pointing at a row that just vanished.
  await selectRow(press, state, "theme");
  await press(key("m"));
  const rows = settingsRowIds(overlay);
  expect(rows.includes("theme")).toBeFalse();
  expect(overlay.cursor).toBeGreaterThan(-1);
  expect(overlay.cursor).toBeLessThan(rows.length);
});

test("the chosen view mode persists: a saved advanced document reopens in advanced", async () => {
  const { source, state, press } = settingsHarness();
  const saved: SaveSettingsCommand[] = [];
  installSave(source, saved);

  await openSettings(press);
  await press(key("m"));
  await press(key("s"));

  expect(saved).toHaveLength(1);
  expect(saved[0]!.document.settingsViewMode).toBe("advanced");

  const restarted = settingsHarness();
  if (!restarted.source.settingsView.editable) {
    throw new Error("demo settings must be editable");
  }
  restarted.source.settingsView = {
    ...restarted.source.settingsView,
    document: saved[0]!.document
  };
  restarted.source.api.getSettings = async () => restarted.source.settingsView;

  await openSettings(restarted.press);

  expect(settingsRowIds(restarted.state.settings!)).toEqual([...SETTINGS_ROW_IDS]);
});

test("a document with no stored view mode loads and defaults to simple", async () => {
  const { state, press } = settingsHarness();
  await openSettings(press);
  const overlay = state.settings!;

  expect(overlay.draft.document?.settingsViewMode).toBe(undefined);
  expect(settingsRowIds(overlay).length).toBeLessThan(SETTINGS_ROW_IDS.length);
  expect(settingsRowIds(overlay)).toContain("system-prompt");
});
