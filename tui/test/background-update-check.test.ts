import { describe, expect, test } from "bun:test";
import {
  RELEASE_LAUNCHER_PACKAGE,
  releaseTargetForArtifact
} from "../../shared/release-targets.js";
import {
  startBackgroundUpdateCheck,
  updateNotice
} from "../src/background-update-check.js";
import { createUpdateCacheEntry, type UpdateCacheKey } from "../src/update-cache.js";
import { UpgradeFailure } from "../src/upgrade-contract.js";
import type { UpgradeRegistry } from "../src/upgrade-plan.js";

const cacheKey: UpdateCacheKey = {
  metadataKind: "npm",
  metadataOrigin: "https://registry.npmjs.org",
  packageName: RELEASE_LAUNCHER_PACKAGE,
  installIdentity: "manual:source:0.1.0",
  currentVersion: "0.1.0",
  artifactTarget: "source",
  channel: "stable",
  prereleasePolicy: "stable-only"
};
const observation = {
  currentVersion: "0.1.0",
  platformPackage: releaseTargetForArtifact("linux-x64").packageName
};

describe("background update checking", () => {
  test("a keyed cache hit avoids network and publishes after the delayed start", async () => {
    const fake = scheduler();
    const notices: string[] = [];
    let registryCalls = 0;
    const stop = startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: null },
      observation,
      cacheKey,
      registry: registry({
        channelHead: async () => {
          registryCalls += 1;
          return "9.9.9";
        }
      }),
      readCache: async () => createUpdateCacheEntry(cacheKey, "0.2.0", 1),
      writeCache: async () => undefined,
      onNotice: (message) => notices.push(message),
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    expect(fake.delays).toEqual([1_000]);
    await fake.runNext();
    expect(registryCalls).toBe(0);
    expect(notices).toEqual([
      "1667 0.2.0 available"
    ]);
    stop();
  });

  test("a fresh success persists a hint and honors skipped versions", async () => {
    const fake = scheduler();
    const written: string[] = [];
    const notices: string[] = [];
    startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: "0.2.0" },
      observation,
      cacheKey,
      registry: registry({ channelHead: async () => "0.2.0" }),
      readCache: async () => null,
      writeCache: async (entry) => { written.push(entry.latest); },
      onNotice: (message) => notices.push(message),
      now: () => 123,
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    await fake.runNext();
    expect(written).toEqual(["0.2.0"]);
    expect(notices).toEqual([]);
  });

  test("network failures remain silent and schedule bounded jittered retry", async () => {
    const fake = scheduler();
    const debug: string[] = [];
    startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: null },
      observation,
      cacheKey,
      registry: registry({
        channelHead: async () => {
          throw new UpgradeFailure("network_error", "offline", true);
        }
      }),
      readCache: async () => null,
      writeCache: async () => undefined,
      onNotice: () => { throw new Error("must stay silent"); },
      onDebug: (message) => debug.push(message),
      random: () => 0,
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    await fake.runNext();
    expect(fake.delays).toEqual([1_000, 3_750]);
    expect(debug[0] ?? "").toContain("offline");
  });

  test("unexpected offline errors remain silent without a retry or crash", async () => {
    const fake = scheduler();
    const notices: string[] = [];
    const debug: string[] = [];
    startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: null },
      observation,
      cacheKey,
      registry: registry({
        channelHead: async () => {
          throw new TypeError("fetch failed: network is offline");
        }
      }),
      readCache: async () => null,
      writeCache: async () => undefined,
      onNotice: (message) => notices.push(message),
      onDebug: (message) => debug.push(message),
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    // `check` runs in a detached Promise. The scheduler must still settle
    // cleanly when fetch rejects with an ordinary platform error.
    await fake.runNext();
    expect(notices).toEqual([]);
    expect(fake.delays).toEqual([1_000]);
    expect(debug[0] ?? "").toContain("network is offline");
  });

  test("non-retryable failures remain silent and stop checking", async () => {
    const fake = scheduler();
    const debug: string[] = [];
    startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: null },
      observation,
      cacheKey,
      registry: registry({
        channelHead: async () => {
          throw new UpgradeFailure("metadata_invalid", "invalid metadata");
        }
      }),
      readCache: async () => null,
      writeCache: async () => undefined,
      onNotice: () => { throw new Error("must stay silent"); },
      onDebug: (message) => debug.push(message),
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    await fake.runNext();
    expect(fake.delays).toEqual([1_000]);
    expect(debug[0] ?? "").toContain("invalid metadata");
  });

  test("off mode schedules nothing and notices only newer versions", () => {
    const fake = scheduler();
    startBackgroundUpdateCheck({
      preferences: { mode: "off", channel: "stable", skippedVersion: null },
      observation,
      cacheKey,
      registry: registry({ channelHead: async () => "0.2.0" }),
      readCache: async () => null,
      writeCache: async () => undefined,
      onNotice: () => undefined,
      schedule: fake.schedule,
      cancel: fake.cancel
    });
    expect(fake.delays).toEqual([]);
    expect(updateNotice("0.1.0", observation)).toBe(null);
    expect(updateNotice("0.0.9", observation)).toBe(null);
  });

  test("build-metadata-only targets notify from a fresh registry head", async () => {
    const fake = scheduler();
    const notices: string[] = [];
    const written: string[] = [];
    const buildCurrent = {
      ...observation,
      currentVersion: "0.1.0+build.1"
    };
    startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: null },
      observation: buildCurrent,
      cacheKey: { ...cacheKey, currentVersion: "0.1.0+build.1" },
      registry: registry({ channelHead: async () => "0.1.0+build.2" }),
      readCache: async () => null,
      writeCache: async (entry) => { written.push(entry.latest); },
      onNotice: (message) => notices.push(message),
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    await fake.runNext();
    await Promise.resolve();
    expect(written).toEqual(["0.1.0+build.2"]);
    expect(notices).toEqual([
      "1667 0.1.0+build.2 available"
    ]);
  });

  test("build-metadata-only targets notify from a keyed cache hit", async () => {
    const fake = scheduler();
    const notices: string[] = [];
    let registryCalls = 0;
    const buildCurrent = {
      ...observation,
      currentVersion: "0.1.0+build.1"
    };
    startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: null },
      observation: buildCurrent,
      cacheKey: { ...cacheKey, currentVersion: "0.1.0+build.1" },
      registry: registry({
        channelHead: async () => {
          registryCalls += 1;
          return "0.1.0+build.2";
        }
      }),
      readCache: async () => createUpdateCacheEntry(
        { ...cacheKey, currentVersion: "0.1.0+build.1" },
        "0.1.0+build.2",
        1
      ),
      writeCache: async () => undefined,
      onNotice: (message) => notices.push(message),
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    await fake.runNext();
    expect(registryCalls).toBe(0);
    expect(notices).toEqual([
      "1667 0.1.0+build.2 available"
    ]);
  });

  test("exact version string equality suppresses notice including equal build metadata", () => {
    expect(updateNotice("0.1.0+build.1", {
      ...observation,
      currentVersion: "0.1.0+build.1"
    })).toBe(null);
    expect(updateNotice("0.1.0", observation)).toBe(null);
    expect(updateNotice("0.1.0+build.2", {
      ...observation,
      currentVersion: "0.1.0+build.1"
    })).toBe("1667 0.1.0+build.2 available");
  });

  test("binds a proven upgrade command to the checked version and channel", () => {
    expect(updateNotice(
      "0.2.0-beta.1",
      observation,
      "1667 upgrade --version 0.2.0-beta.1 --channel beta"
    )).toBe(
      "1667 0.2.0-beta.1 available · run 1667 upgrade --version 0.2.0-beta.1 --channel beta"
    );
    expect(updateNotice("0.2.0", observation)).toBe("1667 0.2.0 available");
    expect(updateNotice("0.2.0", observation)).not.toContain("npm");
  });

  test("stopping aborts an in-flight registry request without scheduling retry", async () => {
    const fake = scheduler();
    const request = { signal: null as AbortSignal | null };
    const stop = startBackgroundUpdateCheck({
      preferences: { mode: "notify", channel: "stable", skippedVersion: null },
      observation,
      cacheKey,
      registry: registry({
        channelHead: async (_channel, signal) => {
          request.signal = signal;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true
            });
          });
          return "0.2.0";
        }
      }),
      readCache: async () => null,
      writeCache: async () => undefined,
      onNotice: () => undefined,
      schedule: fake.schedule,
      cancel: fake.cancel
    });

    await fake.runNext();
    expect(request.signal?.aborted).toBe(false);
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(request.signal?.aborted).toBe(true);
    expect(fake.delays).toEqual([1_000]);
  });
});

function registry(
  methods: Partial<UpgradeRegistry>
): UpgradeRegistry {
  const integrity = `sha512-${"A".repeat(86)}==`;
  return {
    channelHead: methods.channelHead ?? (async () => "0.2.0"),
    launcher: methods.launcher ?? (async (version) => ({
      name: "@1667-ai/cli",
      version,
      integrity,
      tarball: `https://registry.npmjs.org/@1667-ai/cli/-/cli-${version}.tgz`
    })),
    platform: methods.platform ?? (async (packageName, version) => ({
      name: packageName,
      version,
      integrity,
      tarball: `https://registry.npmjs.org/${packageName}/-/${packageName.split("/").pop()}-${version}.tgz`
    }))
  };
}

function scheduler() {
  const tasks: Array<() => void> = [];
  const delays: number[] = [];
  return {
    delays,
    schedule(callback: () => void, delayMs: number) {
      tasks.push(callback);
      delays.push(delayMs);
      return tasks.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() {},
    async runNext() {
      tasks.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}
