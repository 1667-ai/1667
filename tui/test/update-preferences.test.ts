import { describe, expect, test } from "bun:test";
import { resolveUpdatePreferences } from "../src/update-preferences.js";

const configured = {
  mode: "notify" as const,
  channel: "stable" as const,
  skippedVersion: "1.2.3"
};

describe("update preference precedence", () => {
  test("uses persisted configuration by default", () => {
    expect(resolveUpdatePreferences(configured, {})).toEqual(configured);
  });

  test("the exact environment opt-out disables background checks", () => {
    expect(resolveUpdatePreferences(configured, {
      AI_1667_NO_UPDATE_CHECK: "1"
    }).mode).toBe("off");
    expect(resolveUpdatePreferences(configured, {
      AI_1667_NO_UPDATE_CHECK: "true"
    }).mode).toBe("notify");
  });

  test("explicit command policy wins over environment and config", () => {
    expect(resolveUpdatePreferences(configured, {
      AI_1667_NO_UPDATE_CHECK: "1"
    }, {
      mode: "notify",
      channel: "beta"
    })).toEqual({
      mode: "notify",
      channel: "beta",
      skippedVersion: "1.2.3"
    });
  });
});
