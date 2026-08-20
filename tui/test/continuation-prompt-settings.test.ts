import { describe, expect, test } from "bun:test";
import type { SaveSettingsCommand } from "../../shared/settings-v2-types.js";
import { settingsRows } from "../src/settings-row-presentations.js";
import {
  installSave,
  key,
  openSettings,
  selectRow,
  settingsHarness
} from "./settings-test-harness.js";

describe("continuation prompt settings", () => {
  test("the prompt layout row explains and persists the experimental opt-in", async () => {
    const { source, state, press } = settingsHarness();
    const saves: SaveSettingsCommand[] = [];
    installSave(source, saves);

    await openSettings(press);
    state.settings!.viewMode = "advanced";
    await selectRow(press, state, "continuation-prompt");
    const row = settingsRows(state.settings!, state.config).find(
      (candidate) => candidate.id === "continuation-prompt"
    );
    expect(row?.label).toBe("prompt layout");
    expect(row?.value).toBe("[ off ]");
    expect(row?.hint).toContain("experimental");

    await press(key("return"));
    expect(state.settings?.draft.document?.profiles.default?.continuationPromptOptimization)
      .toBe("late-cache-stable");
    expect(state.toast).toContain("experimental prompt · on");
    await press(key("s"));
    expect(saves).toHaveLength(1);
    expect(saves[0]!.document.profiles.default?.continuationPromptOptimization)
      .toBe("late-cache-stable");

    const offHarness = settingsHarness();
    if (!offHarness.source.settingsView.editable) throw new Error("editable settings missing");
    offHarness.source.settingsView = {
      ...offHarness.source.settingsView,
      document: {
        ...offHarness.source.settingsView.document,
        profiles: {
          ...offHarness.source.settingsView.document.profiles,
          default: {
            ...offHarness.source.settingsView.document.profiles.default!,
            continuationPromptOptimization: "late-cache-stable"
          }
        }
      }
    };
    offHarness.source.api.getSettings = async () => offHarness.source.settingsView;
    const offSaves: SaveSettingsCommand[] = [];
    installSave(offHarness.source, offSaves);
    await openSettings(offHarness.press);
    await selectRow(offHarness.press, offHarness.state, "continuation-prompt");
    await offHarness.press(key("left"));
    expect(Object.hasOwn(
      offHarness.state.settings!.draft.document!.profiles.default!,
      "continuationPromptOptimization"
    )).toBe(false);
    await offHarness.press(key("s"));
    expect(offSaves).toHaveLength(1);
    expect(Object.hasOwn(
      offSaves[0]!.document.profiles.default!,
      "continuationPromptOptimization"
    )).toBe(false);
  });
});
