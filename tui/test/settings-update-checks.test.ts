import { describe, expect, test } from "bun:test";
import { UNAVAILABLE_UPDATE_CHECK_LIFECYCLE } from "../src/action-context.js";
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
    let restarts = 0;
    const { source, state, press } = harness(
      undefined,
      { settingsViewMode: "simple" },
      () => { restarts += 1; }
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

    await selectRow(press, state, "update-checks");
    await press(key("return"));
    expect(state.settings?.edit).toBeNull();
    expect(state.config.updates.mode).toBe("off");
    expect(source.config.updates.mode).toBe("off");
    expect(state.toast).toBe("update checks · off");
    expect(restarts).toBe(1);

    await press(key("right"));
    expect(state.config.updates.mode).toBe("notify");
    expect(restarts).toBe(2);
  });

  test("a failed save reports a session-only change", () => {
    let restarts = 0;
    const { source, state } = harness();
    state.demo = false;

    applyUpdateChecksToggle(
      state,
      source,
      { restartUpdateCheck: () => { restarts += 1; } },
      "off",
      () => false
    );

    expect(state.config.updates.mode).toBe("off");
    expect(source.config.updates.mode).toBe("off");
    expect(restarts).toBe(1);
    expect(state.toast).toBe(
      "update checks · off for this session · config not saved"
    );
  });

  test("missing live wiring fails before config changes or persists", () => {
    const { source, state } = harness();
    let saves = 0;

    expect(() => applyUpdateChecksToggle(
      state,
      source,
      UNAVAILABLE_UPDATE_CHECK_LIFECYCLE,
      "off",
      () => { saves += 1; return true; }
    )).toThrow("update-check lifecycle is not configured");

    expect(state.config.updates.mode).toBe("notify");
    expect(source.config.updates.mode).toBe("notify");
    expect(saves).toBe(0);
  });
});
