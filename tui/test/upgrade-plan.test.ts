import { expect, test } from "bun:test";
import { releaseTargetForArtifact } from "../../shared/release-targets.js";
import { UpgradeFailure, type UpgradeChannel } from "../src/upgrade-contract.js";
import {
  planUpgrade,
  type UpgradeObservation,
  type UpgradeRegistry,
  type UpgradeRequest
} from "../src/upgrade-plan.js";
import type { PlatformPackage } from "../src/npm-upgrade-registry.js";

const observation: UpgradeObservation = {
  currentVersion: "1.2.3",
  platformPackage: releaseTargetForArtifact("linux-x64").packageName
};

test("read-only checks resolve channel state without exact-version requests", async () => {
  const registry = fakeRegistry("1.3.0");
  const result = await planUpgrade(request({ check: true }), observation, registry);
  expect(result).toEqual({
    status: "manual",
    current: "1.2.3",
    latest: "1.3.0",
    target: "1.3.0",
    channel: "stable",
    method: "manual",
    restartRequired: false,
    command: null,
    error: null
  });
  expect(registry.calls).toEqual(["tags:stable"]);
});

test("fresh plans validate launcher and platform metadata before returning data", async () => {
  const registry = fakeRegistry("1.3.0");
  const result = await planUpgrade(request(), observation, registry);
  expect(result.status).toBe("manual");
  expect(result.command).toBe(null);
  expect(registry.calls[0]).toBe("tags:stable");
  expect(new Set(registry.calls.slice(1))).toEqual(new Set([
    "launcher:1.3.0",
    `platform:${observation.platformPackage}:1.3.0`
  ]));
});

test("manual observations still require exact metadata verification", async () => {
  const registry = fakeRegistry("1.3.0");
  const result = await planUpgrade(request(), observation, registry);
  expect(result.status).toBe("manual");
  expect(result.target).toBe("1.3.0");
  expect(result.command).toBe(null);
  expect(registry.calls).toHaveLength(3);
});

test("explicit versions must equal the fresh channel head", async () => {
  const registry = fakeRegistry("1.3.1");
  const error = await rejection(planUpgrade(
    request({ version: "1.3.0" }),
    observation,
    registry
  ));
  expect((error as UpgradeFailure).code).toBe("unsupported_target");
  expect(registry.calls).toEqual(["tags:stable"]);
});

test("a newer local build is current unless an explicit downgrade was requested", async () => {
  const implicitRegistry = fakeRegistry("1.2.2");
  const implicit = await planUpgrade(request(), observation, implicitRegistry);
  expect(implicit).toMatchObject({
    status: "up-to-date",
    current: "1.2.3",
    latest: "1.2.2",
    target: null
  });
  expect(implicitRegistry.calls).toEqual(["tags:stable"]);

  const explicitRegistry = fakeRegistry("1.2.2");
  const error = await rejection(planUpgrade(
    request({ version: "1.2.2" }),
    observation,
    explicitRegistry
  ));
  expect((error as UpgradeFailure).code).toBe("unsupported_target");
  expect(explicitRegistry.calls).toEqual(["tags:stable"]);
});

test("pre-aborted operations terminate before registry I/O", async () => {
  const controller = new AbortController();
  controller.abort();
  const registry = fakeRegistry("1.3.0");
  const error = await rejection(planUpgrade(request(), observation, registry, controller.signal));
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
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true
      });
    });
  };

  const error = await rejection(planUpgrade(request(), observation, registry));
  expect((error as UpgradeFailure).code).toBe("verification_failed");
  expect(platformRequest.signal?.aborted).toBe(true);
});

function request(overrides: Partial<UpgradeRequest> = {}): UpgradeRequest {
  return { check: false, version: null, channel: "stable", ...overrides };
}

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}
