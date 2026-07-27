import { expect, test } from "bun:test";
import { releaseTargetForArtifact } from "../../shared/release-targets.js";
import {
  executeUpgradeCli,
  parseUpgradeArguments
} from "../src/upgrade-cli.js";
import { UpgradeFailure, type UpgradeChannel } from "../src/upgrade-contract.js";
import type { PlatformPackage } from "../src/npm-upgrade-registry.js";
import type { UpgradeObservation, UpgradeRegistry } from "../src/upgrade-plan.js";

const observation: UpgradeObservation = {
  currentVersion: "1.2.3",
  platformPackage: releaseTargetForArtifact("linux-x64").packageName
};

test("upgrade argument parser preserves global version semantics and rejects ambiguity", () => {
  expect(parseUpgradeArguments([
    "--version", "2.0.0-beta.1", "--channel=beta", "--json"
  ])).toEqual({
    check: false,
    version: "2.0.0-beta.1",
    channel: "beta"
  });
  expect(() => parseUpgradeArguments(["--check", "--version", "2.0.0"])).toThrow();
  expect(() => parseUpgradeArguments(["--version", "v2.0.0"])).toThrow();
  expect(() => parseUpgradeArguments(["--channel", "nightly"])).toThrow();
  expect(() => parseUpgradeArguments(["--json", "--json"])).toThrow();
});

test("persisted channel is the default and an explicit flag wins", () => {
  expect(parseUpgradeArguments(["--check"], "beta")?.channel).toBe("beta");
  expect(parseUpgradeArguments(["--check", "--channel", "stable"], "beta")?.channel)
    .toBe("stable");
});

test("JSON success emits exactly one stable envelope and command stays null", async () => {
  const result = await executeUpgradeCli(["--check", "--json"], {
    observation,
    registry: fakeRegistry("1.3.0")
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n")).toHaveLength(2);
  expect(JSON.parse(result.stdout)).toEqual(result.envelope);
  expect(Object.keys(JSON.parse(result.stdout))).toEqual([
    "status",
    "current",
    "latest",
    "target",
    "channel",
    "method",
    "restartRequired",
    "command",
    "error"
  ]);
  expect(JSON.parse(result.stdout).command).toBe(null);
});

test("JSON usage and operational failures retain the same envelope", async () => {
  const usage = await executeUpgradeCli(["--check", "--version", "2.0.0", "--json"], {
    observation,
    registry: fakeRegistry("2.0.0")
  });
  expect(usage.exitCode).toBe(2);
  expect(usage.stderr).toBe("");
  expect(JSON.parse(usage.stdout).error.code).toBe("invalid_arguments");
  expect(JSON.parse(usage.stdout).method).toBe("manual");
  expect(JSON.parse(usage.stdout).command).toBe(null);

  const registry = fakeRegistry("2.0.0");
  registry.channelHead = async () => {
    throw new UpgradeFailure("network_error", "Could not check for updates.", true);
  };
  const failure = await executeUpgradeCli(["--json"], { observation, registry });
  expect(failure.exitCode).toBe(1);
  expect(failure.stderr).toBe("");
  expect(JSON.parse(failure.stdout).error).toEqual({
    code: "network_error",
    message: "Could not check for updates.",
    retryable: true,
    details: null
  });
});

test("interruption emits exit 130 and one JSON envelope", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeUpgradeCli(["--check", "--json"], {
    observation,
    registry: fakeRegistry("2.0.0"),
    signal: controller.signal
  });
  expect(result.exitCode).toBe(130);
  expect(JSON.parse(result.stdout).error.code).toBe("interrupted");
  expect(JSON.parse(result.stdout).command).toBe(null);
});

test("human plan output uses only locally derived fixed instructions", async () => {
  const result = await executeUpgradeCli(["--version", "2.0.0"], {
    observation,
    registry: fakeRegistry("2.0.0")
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("1667 2.0.0 is available");
  expect(result.stdout).toContain(
    "https://www.npmjs.com/package/@1667-ai/cli/v/2.0.0"
  );
  expect(result.stdout).not.toContain("%2f");
  expect(result.stdout).not.toContain("github");
  expect(result.stdout).toContain("outside 1667's trust boundary");
  expect(result.stdout).not.toContain("npm install");
});

test("human checks defer exact instructions until a fresh plan", async () => {
  const result = await executeUpgradeCli(["--check"], {
    observation,
    registry: fakeRegistry("2.0.0")
  });
  expect(result.stdout).toContain("Run '1667 upgrade'");
  expect(result.stdout).not.toContain("https://");
  expect(result.stdout).not.toContain("Verified metadata source");
});

test("manual current releases do not recommend a redundant reinstall", async () => {
  const result = await executeUpgradeCli([], {
    observation,
    registry: fakeRegistry("1.2.3")
  });
  expect(result.stdout).toContain("is up to date");
  expect(result.stdout).not.toContain("Instructions:");
});

test("help is local and performs no registry I/O", async () => {
  const registry = fakeRegistry("2.0.0");
  const result = await executeUpgradeCli(["--help"], { observation, registry });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Phase one is read-only");
  expect(registry.calls).toEqual([]);
});

function fakeRegistry(head: string): UpgradeRegistry & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async channelHead(channel: UpgradeChannel) {
      calls.push(`tags:${channel}`);
      return head;
    },
    async launcher(version: string) {
      calls.push(`launcher:${version}`);
    },
    async platform(packageName: PlatformPackage, version: string) {
      calls.push(`platform:${packageName}:${version}`);
    }
  };
}
