import { describe, expect, test } from "bun:test";
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
  packageName: "1667",
  installIdentity: "manual:source:0.1.0",
  currentVersion: "0.1.0",
  artifactTarget: "source",
  channel: "stable",
  prereleasePolicy: "stable-only"
};
const observation = {
  currentVersion: "0.1.0",
  platformPackage: "1667-linux-x64" as const
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
    expect(notices).toEqual(["1667 0.2.0 available · see npmjs.com/package/1667"]);
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
  return {
    channelHead: methods.channelHead ?? (async () => "0.2.0"),
    launcher: methods.launcher ?? (async () => undefined),
    platform: methods.platform ?? (async () => undefined)
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
