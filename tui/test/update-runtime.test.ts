import { describe, expect, test } from "bun:test";
import {
  PUBLISHED_RELEASE_TARGETS,
  RELEASE_TARGETS
} from "../../shared/release-targets.js";
import { normalizeUserConfig } from "../src/config.js";
import { createBackgroundUpdateStarter } from "../src/update-runtime.js";

const PUBLISHED_HOST = PUBLISHED_RELEASE_TARGETS[0];
if (PUBLISHED_HOST === undefined) throw new Error("no published release target");

describe("default background update runtime", () => {
  test("does not construct a checker by default or when explicitly disabled", () => {
    const host = [PUBLISHED_HOST.platform, PUBLISHED_HOST.arch] as const;
    expect(createBackgroundUpdateStarter(normalizeUserConfig(null), {}, ...host)).toBe(null);
    expect(createBackgroundUpdateStarter(normalizeUserConfig({
      updates: { mode: "off" }
    }), {}, ...host)).toBe(null);
    expect(createBackgroundUpdateStarter(normalizeUserConfig(null), {
      AI_1667_NO_UPDATE_CHECK: "1"
    }, ...host)).toBe(null);
  });

  test("explicit notify config opts in without doing network or filesystem work", () => {
    const starter = createBackgroundUpdateStarter(
      normalizeUserConfig({ updates: { mode: "notify" } }),
      {},
      PUBLISHED_HOST.platform,
      PUBLISHED_HOST.arch
    );
    expect(typeof starter).toBe("function");
  });

  // Asking only about the host would cover one target. Assert every canonical
  // target so the outcome continues to track `heldFromPublication`.
  test("a starter follows the target's publication state, not the test host", () => {
    const config = normalizeUserConfig({ updates: { mode: "notify" } });
    for (const descriptor of RELEASE_TARGETS) {
      const starter = createBackgroundUpdateStarter(
        config,
        {},
        descriptor.platform,
        descriptor.arch
      );
      if (descriptor.heldFromPublication === null) {
        expect(typeof starter).toBe("function");
      } else {
        // Polling for a package no registry has could only produce 404 noise.
        expect(starter).toBe(null);
      }
    }
    // An unsupported runtime has no package to poll for either.
    expect(createBackgroundUpdateStarter(config, {}, "sunos", "mips")).toBe(null);
  });
});
