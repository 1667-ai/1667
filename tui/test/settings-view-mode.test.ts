import { expect, test } from "bun:test";
import { SETTINGS_ROW_IDS, settingsRowIds } from "../src/settings-row-navigation.js";
import { settingsCursorRowIdentity } from "../src/settings-row-navigation.js";
import { settingsDraftChanged } from "../src/settings-overlay-model.js";
import { settingsTextDraftWithSubscriptionPlan } from "../src/settings-text.js";
import {
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import { configureNetworkSource } from "./settings-model-provenance-test-helpers.js";

test("simple mode shows only the intended rows, and advanced mode shows every row unchanged", async () => {
  const { state, press } = settingsHarness(undefined, { settingsViewMode: "simple" });
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
  const { source, state, press } = settingsHarness(undefined, { settingsViewMode: "simple" });
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
  const { state, press } = settingsHarness(undefined, { settingsViewMode: "simple" });
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

// Regression test: `settingsViewMode` lives in `UserConfig` now, not the
// settings document (settings-view-mode.ts), so the chosen mode has to
// survive closing and reopening the panel through the config, not a saved
// document round trip.
test("toggling the view mode persists across closing and reopening the panel", async () => {
  const { state, press } = settingsHarness(undefined, { settingsViewMode: "simple" });
  await openSettings(press);
  expect(state.settings!.viewMode).toBe("simple");

  await press(key("m"));
  expect(state.settings!.viewMode).toBe("advanced");
  expect(state.config.settingsViewMode).toBe("advanced");

  await press(key("escape"));
  expect(state.mode).toBe("NAV");
  await openSettings(press);

  expect(state.settings!.viewMode).toBe("advanced");
  expect(settingsRowIds(state.settings!)).toEqual([...SETTINGS_ROW_IDS]);
});

// Regression test: `toggleSettingsViewMode` used to also patch
// `overlay.draft.document`, which `settingsDraftChanged`'s `JSON.stringify`
// comparison reads as a real edit — the panel then showed "unsaved draft ·
// s saves" after a pure view action, and `s` fired a full save mutation just
// to record a view preference. `m` now only ever touches `overlay.viewMode`
// and the config, never the draft.
test("toggling the view mode does not dirty the settings draft", async () => {
  const { state, press } = settingsHarness(undefined, { settingsViewMode: "simple" });
  await openSettings(press);
  const overlay = state.settings!;
  expect(settingsDraftChanged(overlay)).toBeFalse();

  await press(key("m"));

  expect(settingsDraftChanged(overlay)).toBeFalse();
  expect(overlay.conflict).toBe(null);
  expect(state.toast).toBe("advanced view");
});
