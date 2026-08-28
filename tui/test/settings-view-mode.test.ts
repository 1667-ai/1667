import { expect, test } from "bun:test";
import { SETTINGS_ROW_IDS, settingsRowIds } from "../src/settings-row-navigation.js";
import { settingsCursorRowIdentity } from "../src/settings-row-navigation.js";
import { settingsDraftChanged } from "../src/settings-overlay-model.js";
import { settingsTextDraftWithSubscriptionPlan } from "../src/settings-text.js";
import { publishCurrentSettingsModelDiscovery } from "../src/settings-model-discovery.js";
import { renderStoryScreen } from "../src/screens/story.js";
import { frameText } from "../src/screens/story/frame.js";
import { settingsFooterVariants } from "../src/screens/settings-panel-footers.js";
import {
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";
import { configureNetworkSource } from "./settings-model-provenance-test-helpers.js";

test("the footer names the view that the mode toggle will open", async () => {
  const { state, cache, press } = settingsHarness();
  await openSettings(press);

  const rendered = (width = 120) => frameText(renderStoryScreen(state, {
    width,
    height: 36,
    wrapCache: cache
  }).lines);

  expect(rendered()).toContain("m simple");
  expect(rendered()).not.toContain("m mode");

  await press(key("m"));

  expect(rendered()).toContain("m advanced");
  expect(rendered()).not.toContain("m mode");

  publishCurrentSettingsModelDiscovery(state.settings!, {
    observedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        remoteId: "model-a",
        name: "Model A",
        contextWindow: 32_768,
        maxOutputTokens: null,
        source: "openai-models"
      },
      {
        remoteId: "model-b",
        name: "Model B",
        contextWindow: 32_768,
        maxOutputTokens: null,
        source: "openai-models"
      }
    ]
  });
  await selectRow(press, state, "model");

  expect(rendered(80)).toContain("m advanced");
});

test("profile footers name the destination view with and without a pending change", async () => {
  const { state, press } = settingsHarness();
  await openSettings(press);
  await selectRow(press, state, "profile");
  const footer = () => settingsFooterVariants(state.settings!, false)[0]!;

  expect(footer().text).toContain("m simple");
  expect(footer().text).not.toContain("m mode");

  const view = state.settings!.view;
  if (!view.editable) throw new Error("editable settings view missing");
  state.settings!.view = { ...view, pendingRevision: 2 };
  expect(footer().text).toContain("x discard");
  expect(footer().text).toContain("m simple");

  await press(key("m"));

  expect(footer().text).toContain("m advanced");
  expect(footer().text).not.toContain("m mode");
});

test("simple mode shows only the intended rows, and advanced mode shows every row unchanged", async () => {
  const { state, press } = settingsHarness(undefined, { settingsViewMode: "simple" });
  await openSettings(press);
  const overlay = state.settings!;

  // Default demo settings use dry-run, so base-url/api-key stay visible in
  // simple mode too — they are hidden only by the fixed-subscription rule.
  expect(settingsRowIds(overlay)).toEqual([
    "theme", "update-checks", "default-author-brief", "default-continue-direction",
    "provider", "base-url", "api-key", "model", "context-window"
  ]);

  await press(key("m"));

  expect(settingsRowIds(overlay)).toEqual([...SETTINGS_ROW_IDS]);
});

test("simple mode can change the theme", async () => {
  const { source, state, press } = settingsHarness(
    undefined,
    { settingsViewMode: "simple" }
  );
  await openSettings(press);

  expect(settingsRowIds(state.settings!)[state.settings!.cursor]).toBe("theme");
  await press(key("right"));

  expect(state.config.theme).toBe("iron gall");
  expect(source.config.theme).toBe("iron gall");
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

  // "compose-focus" only exists in advanced mode. Flipping back to simple must not
  // leave the cursor pointing at a row that just vanished.
  await selectRow(press, state, "compose-focus");
  await press(key("m"));
  const rows = settingsRowIds(overlay);
  expect(rows.includes("compose-focus")).toBeFalse();
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
