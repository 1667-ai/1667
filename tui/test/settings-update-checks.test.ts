import { describe, expect, test } from "bun:test";
import { settingsRows } from "../src/settings-overlay-model.js";
import { settingsRowIds } from "../src/settings-row-navigation.js";
import { applyUpdateChecksToggle } from "../src/settings-selector-actions.js";
import {
  key,
  openSettings,
  selectRow,
  settingsHarness as harness
} from "./settings-test-harness.js";

describe("Settings update checks", () => {
  test("the simple view toggles the live checker", async () => {
    const starts: string[] = [];
    let stops = 0;
    const { source, state, press } = harness(
      undefined,
      { settingsViewMode: "simple" },
      (config) => {
        starts.push(config.updates.mode);
        return () => { stops += 1; };
      }
    );
    await openSettings(press);

    expect(state.config.updates.mode).toBe("notify");
    expect(state.settings && settingsRowIds(state.settings))
      .toContain("update-checks");
    expect(settingsRows(state.settings!, state.config)
      .find((row) => row.id === "update-checks"))
      .toMatchObject({
        value: "[ on ]",
        hint: "Checks for a newer version. Sends no story or account data."
      });
    expect(starts).toEqual(["notify"]);

    await selectRow(press, state, "update-checks");
    await press(key("return"));
    expect(state.settings?.edit).toBeNull();
    expect(state.config.updates.mode).toBe("off");
    expect(source.config.updates.mode).toBe("off");
    expect(state.toast).toBe("update checks · off");
    expect(starts).toEqual(["notify", "off"]);
    expect(stops).toBe(1);

    await press(key("right"));
    expect(state.config.updates.mode).toBe("notify");
    expect(starts).toEqual(["notify", "off", "notify"]);
    expect(stops).toBe(2);
  });

  test("a failed save reports a session-only change", () => {
    const { source, state } = harness();
    state.demo = false;

    applyUpdateChecksToggle(
      state,
      source,
      "off",
      () => false
    );

    expect(state.config.updates.mode).toBe("off");
    expect(source.config.updates.mode).toBe("off");
    expect(state.toast).toBe(
      "update checks · off for this session · config not saved"
    );
  });
});
