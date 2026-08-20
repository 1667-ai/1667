import { describe, expect, test } from "bun:test";
import {
  PUBLISHED_RELEASE_TARGETS,
  RELEASE_TARGETS
} from "../../shared/release-targets.js";
import { normalizeUserConfig } from "../src/config.js";
import {
  createBackgroundUpdateStarter,
  upgradeCommandForAuthority
} from "../src/update-runtime.js";
import type { InstallationAuthority } from "../src/install-ownership.js";

const PUBLISHED_HOST = PUBLISHED_RELEASE_TARGETS[0];
if (PUBLISHED_HOST === undefined) throw new Error("no published release target");

describe("default background update runtime", () => {
  test("maps only proven install authority to an upgrade command", () => {
    const manual: InstallationAuthority = { kind: "manual" };
    expect(upgradeCommandForAuthority(manual)).toBe(undefined);

    const shell: InstallationAuthority = {
      kind: "shell",
      record: {
        schemaVersion: 1,
        product: "1667",
        installationId: "a".repeat(32),
        method: "shell",
        channel: "stable",
        installRoot: "/tmp/1667",
        executable: "/tmp/1667/1667",
        artifactTarget: "linux-x64"
      },
      installRoot: "/tmp/1667",
      executable: "/tmp/1667/1667"
    };
    expect(upgradeCommandForAuthority(shell)).toBe(
      "run 1667 upgrade"
    );

    const powershell: InstallationAuthority = {
      kind: "powershell",
      channel: "stable",
      installRoot: "C:\\Users\\test\\1667",
      executable: "C:\\Users\\test\\1667\\1667.exe"
    };
    expect(upgradeCommandForAuthority(powershell)).toBe("run 1667 upgrade");
  });

  test("constructs a checker by default and honors explicit opt-out", () => {
    const host = [PUBLISHED_HOST.platform, PUBLISHED_HOST.arch] as const;
    expect(typeof createBackgroundUpdateStarter(normalizeUserConfig(null), {}, ...host)).toBe("function");
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

  test("does not require an npm executable", () => {
    const starter = createBackgroundUpdateStarter(
      normalizeUserConfig({ updates: { mode: "notify" } }),
      { PATH: "" },
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
