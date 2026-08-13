import { expect, test } from "bun:test";
import { releaseTargetForArtifact } from "../../shared/release-targets.js";
import type { UpgradeApplyCommand, UpgradeCheckCommand } from "../src/upgrade-command.js";
import { UpgradeFailure, type UpgradeChannel } from "../src/upgrade-contract.js";
import {
  planUpgrade,
  type UpgradeObservation,
  type UpgradeRegistry
} from "../src/upgrade-plan.js";
import type { PlatformPackage } from "../src/npm-upgrade-registry.js";

const observation: UpgradeObservation = {
  currentVersion: "1.2.3",
  platformPackage: releaseTargetForArtifact("linux-x64").packageName
};

test("read-only checks resolve channel state without exact-version requests", async () => {
  const registry = fakeRegistry("1.3.0");
  const result = await planUpgrade(checkCommand(), observation, registry);
  expect(result).toEqual({
    status: "target-available",
    current: "1.2.3",
    latest: "1.3.0",
    target: "1.3.0",
    channel: "stable"
  });
  expect(registry.calls).toEqual(["tags:stable"]);
  expect("platformMetadata" in result).toBe(false);
});

test("fresh apply plans validate launcher and platform metadata before returning data", async () => {
  const registry = fakeRegistry("1.3.0");
  const result = await planUpgrade(applyCommand(), observation, registry);
  expect(result.status).toBe("target-available");
  if (result.status !== "target-available") throw new Error("expected target");
  expect(result.platformMetadata.version).toBe("1.3.0");
  expect(result.platformMetadata.name).toBe(observation.platformPackage);
  expect(registry.calls[0]).toBe("tags:stable");
  expect(new Set(registry.calls.slice(1))).toEqual(new Set([
    "launcher:1.3.0",
    `platform:${observation.platformPackage}:1.3.0`
  ]));
});

test("apply plans always verify exact metadata when a target is available", async () => {
  const registry = fakeRegistry("1.3.0");
  const result = await planUpgrade(applyCommand(), observation, registry);
  expect(result.status).toBe("target-available");
  if (result.status !== "target-available") throw new Error("expected target");
  expect(result.target).toBe("1.3.0");
  expect(result.platformMetadata).toBeDefined();
  expect(registry.calls).toHaveLength(3);
});

test("explicit versions select an exact published release instead of the channel head", async () => {
  const registry = fakeRegistry("1.3.1");
  const plan = await planUpgrade(
    applyCommand({ version: "1.3.0" }),
    observation,
    registry
  );
  expect(plan).toMatchObject({
    status: "target-available",
    current: "1.2.3",
    latest: "1.3.1",
    target: "1.3.0"
  });
  expect(registry.calls).toEqual([
    "tags:stable",
    "launcher:1.3.0",
    `platform:${observation.platformPackage}:1.3.0`
  ]);
});

test("a newer local build stays current without an exact version", async () => {
  const implicitRegistry = fakeRegistry("1.2.2");
  const implicit = await planUpgrade(applyCommand(), observation, implicitRegistry);
  expect(implicit).toMatchObject({
    status: "up-to-date",
    current: "1.2.3",
    latest: "1.2.2",
    target: null
  });
  expect(implicitRegistry.calls).toEqual(["tags:stable"]);
});

test("an exact older version creates a verified downgrade plan", async () => {
  const registry = fakeRegistry("1.3.0");
  const plan = await planUpgrade(
    applyCommand({ version: "1.1.0" }),
    observation,
    registry
  );
  expect(plan).toMatchObject({
    status: "target-available",
    current: "1.2.3",
    latest: "1.3.0",
    target: "1.1.0"
  });
  if (plan.status !== "target-available") throw new Error("expected target");
  expect(plan.platformMetadata.version).toBe("1.1.0");
  expect(registry.calls).toEqual([
    "tags:stable",
    "launcher:1.1.0",
    `platform:${observation.platformPackage}:1.1.0`
  ]);
});

test("exact SemVer string equality is the only up-to-date identity", async () => {
  const sameString = fakeRegistry("1.2.3+build.1");
  const upToDate = await planUpgrade(
    checkCommand(),
    { ...observation, currentVersion: "1.2.3+build.1" },
    sameString
  );
  expect(upToDate).toMatchObject({
    status: "up-to-date",
    current: "1.2.3+build.1",
    latest: "1.2.3+build.1",
    target: null
  });
  expect(sameString.calls).toEqual(["tags:stable"]);
});

test("same SemVer precedence with different build metadata stays available", async () => {
  const channelRegistry = fakeRegistry("1.2.3+build.2");
  const channelPlan = await planUpgrade(
    checkCommand(),
    { ...observation, currentVersion: "1.2.3+build.1" },
    channelRegistry
  );
  expect(channelPlan).toMatchObject({
    status: "target-available",
    current: "1.2.3+build.1",
    latest: "1.2.3+build.2",
    target: "1.2.3+build.2"
  });
  expect(channelRegistry.calls).toEqual(["tags:stable"]);

  const explicitRegistry = fakeRegistry("1.2.3+build.2");
  const explicitPlan = await planUpgrade(
    applyCommand({ version: "1.2.3+build.2" }),
    { ...observation, currentVersion: "1.2.3+build.1" },
    explicitRegistry
  );
  expect(explicitPlan).toMatchObject({
    status: "target-available",
    current: "1.2.3+build.1",
    latest: "1.2.3+build.2",
    target: "1.2.3+build.2"
  });
  if (explicitPlan.status !== "target-available") throw new Error("expected target");
  expect(explicitPlan.platformMetadata.version).toBe("1.2.3+build.2");
  expect(explicitRegistry.calls[0]).toBe("tags:stable");
  expect(new Set(explicitRegistry.calls.slice(1))).toEqual(new Set([
    "launcher:1.2.3+build.2",
    `platform:${observation.platformPackage}:1.2.3+build.2`
  ]));
});

test("pre-aborted operations terminate before registry I/O", async () => {
  const controller = new AbortController();
  controller.abort();
  const registry = fakeRegistry("1.3.0");
  const error = await rejection(planUpgrade(
    applyCommand(),
    observation,
    registry,
    controller.signal
  ));
  expect((error as UpgradeFailure).code).toBe("interrupted");
  expect(registry.calls).toEqual([]);
});

test("an exact-metadata failure aborts its in-flight sibling", async () => {
  const platformRequest = { signal: null as AbortSignal | null };
  const registry = fakeRegistry("1.3.0");
  registry.launcher = async () => {
    throw new UpgradeFailure("verification_failed", "bad launcher");
  };
  registry.platform = async (_packageName, _version, signal) => {
    platformRequest.signal = signal;
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true
      });
    });
  };

  const error = await rejection(planUpgrade(applyCommand(), observation, registry));
  expect((error as UpgradeFailure).code).toBe("verification_failed");
  expect(platformRequest.signal?.aborted).toBe(true);
});

test("neutral plan never carries install method", async () => {
  const check = await planUpgrade(checkCommand(), observation, fakeRegistry("1.3.0"));
  const apply = await planUpgrade(applyCommand(), observation, fakeRegistry("1.3.0"));
  expect("method" in check).toBe(false);
  expect("method" in apply).toBe(false);
});

function checkCommand(
  overrides: Partial<Omit<UpgradeCheckCommand, "kind">> = {}
): UpgradeCheckCommand {
  return { kind: "check", channel: "stable", ...overrides };
}

function applyCommand(
  overrides: Partial<Omit<UpgradeApplyCommand, "kind">> = {}
): UpgradeApplyCommand {
  return { kind: "apply", version: null, channel: "stable", ...overrides };
}

function fakeRegistry(head: string): UpgradeRegistry & { calls: string[] } {
  const calls: string[] = [];
  const integrity = `sha512-${"A".repeat(86)}==`;
  return {
    calls,
    async channelHead(channel: UpgradeChannel) {
      calls.push(`tags:${channel}`);
      return head;
    },
    async launcher(version: string) {
      calls.push(`launcher:${version}`);
      return {
        name: "@1667-ai/cli",
        version,
        integrity,
        tarball: `https://registry.npmjs.org/@1667-ai/cli/-/cli-${version}.tgz`
      };
    },
    async platform(packageName: PlatformPackage, version: string) {
      calls.push(`platform:${packageName}:${version}`);
      return {
        name: packageName,
        version,
        integrity,
        tarball: `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").pop()}-${version}.tgz`
      };
    }
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}
