import { describe, expect, test } from "bun:test";
import { normalizeUserConfig } from "../src/config.js";
import { createBackgroundUpdateStarter } from "../src/update-runtime.js";

describe("default background update runtime", () => {
  test("does not construct a checker by default or when explicitly disabled", () => {
    expect(createBackgroundUpdateStarter(normalizeUserConfig(null), {})).toBe(null);
    expect(createBackgroundUpdateStarter(normalizeUserConfig({
      updates: { mode: "off" }
    }), {})).toBe(null);
    expect(createBackgroundUpdateStarter(normalizeUserConfig(null), {
      AI_1667_NO_UPDATE_CHECK: "1"
    })).toBe(null);
  });

  test("explicit notify config opts in without doing network or filesystem work", () => {
    const starter = createBackgroundUpdateStarter(normalizeUserConfig({
      updates: { mode: "notify" }
    }), {});
    expect(typeof starter).toBe("function");
  });
});
