import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertWithinBudget,
  budgetTimeout,
  fileBudget,
  startTiming,
  type Budget,
  type Timing
} from "./performance-budget.js";
import { DataDirectoryLock } from "../server/data-directory-lock.js";
import { SETTINGS_STATE_V1_FILE } from "../server/data-directory-layout.js";
import { readSettingsState } from "../server/settings-state-file.js";
import { formatGenerationSettingsV1 } from "../server/settings-v1-codec.js";
import {
  MAX_SETTINGS_AUTHOR_BRIEF_SCALARS,
  MAX_SETTINGS_NAME_SCALARS,
  MAX_SETTINGS_REMOTE_ID_SCALARS,
  MAX_SETTINGS_URL_SCALARS
} from "../server/settings-v2-scalars.js";
import type { GenerationSettings } from "../shared/types.js";

const MIB = 1024 * 1024;
const MAX_RSS_GROWTH = 128 * MIB;
const MAX_HEAP_GROWTH = 64 * MIB;
// Each migration reads and writes the data directory, so these measure
// wall-clock time.
const NEAR_LIMIT_BUDGET = fileBudget(15_000);
const ABSENT_DEFAULT_BUDGET = fileBudget(15_000);
const RETRY_BUDGET = fileBudget(30_000);
const NO_OP_BUDGET = fileBudget(10_000);

test(
  "ADR003 Release B migration stays bounded across first-run, retry, and no-op paths",
  {
    concurrency: 1,
    timeout: budgetTimeout(
      [NEAR_LIMIT_BUDGET, ABSENT_DEFAULT_BUDGET, RETRY_BUDGET, NO_OP_BUDGET],
      20_000
    )
  },
  async (t) => {
    await t.test("near-limit file-present v1 migration", async (context) => {
      const settings = nearLimitSettings();
      const settingsText = formatGenerationSettingsV1(settings);
      assert.ok(
        Buffer.byteLength(settingsText, "utf8") > 68 * 1024,
        "the file-present fixture must exercise the v1 scalar limits"
      );
      const dataDir = await initializedFormat1Directory(
        context,
        "1667-settings-migration-near-limit-"
      );
      await writeFile(path.join(dataDir, SETTINGS_STATE_V1_FILE), settingsText, {
        mode: 0o600
      });
      const lock = new DataDirectoryLock(dataDir);
      await lock.acquire();

      const measurement = await measure(async () => {
        try {
          return await lock.migrateSettingsFormat();
        } finally {
          await lock.release();
        }
      });

      assert.equal(measurement.value, 3);
      const migratedModel = (await readSettingsState(dataDir))
        .documents["1"]?.models["migrated:model"];
      assert.equal(migratedModel?.remoteId, settings.model);
      assert.equal(
        migratedModel?.name,
        settings.model.slice(0, MAX_SETTINGS_NAME_SCALARS)
      );
      assertPerformanceBound(context, "near-limit file migration", measurement, NEAR_LIMIT_BUDGET);
    });

    await t.test("absent-default migration", async (context) => {
      const dataDir = await initializedFormat1Directory(
        context,
        "1667-settings-migration-absent-"
      );
      const lock = new DataDirectoryLock(dataDir);
      await lock.acquire();

      const measurement = await measure(async () => {
        try {
          return await lock.migrateSettingsFormat();
        } finally {
          await lock.release();
        }
      });

      assert.equal(measurement.value, 3);
      assertPerformanceBound(context, "absent-default migration", measurement, ABSENT_DEFAULT_BUDGET);
    });

    await t.test("crash after staging followed by a convergent retry", async (context) => {
      const dataDir = await initializedFormat1Directory(
        context,
        "1667-settings-migration-retry-"
      );
      const first = new DataDirectoryLock(dataDir);

      const measurement = await measure(async () => {
        await first.acquire();
        try {
          await assert.rejects(
            first.migrateSettingsFormat({
              hooks: {
                afterStateStaged: () => {
                  throw new Error("injected post-stage crash");
                }
              }
            }),
            /injected post-stage crash/
          );
        } finally {
          await first.release();
        }

        const retry = new DataDirectoryLock(dataDir);
        await retry.acquire();
        try {
          return await retry.migrateSettingsFormat();
        } finally {
          await retry.release();
        }
      });

      assert.equal(measurement.value, 3);
      assertPerformanceBound(context, "post-crash migration retry", measurement, RETRY_BUDGET);
    });

    await t.test("already-current-format startup no-op", async (context) => {
      const dataDir = await makeDataDirectory(
        context,
        "1667-settings-migration-noop-"
      );
      const lock = new DataDirectoryLock(dataDir);
      await lock.acquire();
      assert.equal(lock.dataFormat, 3);
      const iterations = 10_000;

      const measurement = await measure(async () => {
        try {
          let selectedFormat = 0;
          for (let index = 0; index < iterations; index += 1) {
            selectedFormat += await lock.migrateSettingsFormat();
          }
          return selectedFormat;
        } finally {
          await lock.release();
        }
      });

      assert.equal(measurement.value, iterations * 3);
      assertPerformanceBound(
        context,
        `${iterations.toLocaleString()} format-3 no-ops`,
        measurement,
        NO_OP_BUDGET
      );
    });
  }
);

function nearLimitSettings(): GenerationSettings {
  const baseUrlPrefix = "https://example.com/";
  return {
    provider: "openai-compatible",
    baseUrl: baseUrlPrefix + "x".repeat(MAX_SETTINGS_URL_SCALARS - baseUrlPrefix.length),
    model: "m".repeat(MAX_SETTINGS_REMOTE_ID_SCALARS),
    apiKeyEnv: null,
    temperature: 0.9,
    maxTokens: 1_000_000_000,
    systemPrompt: "p".repeat(MAX_SETTINGS_AUTHOR_BRIEF_SCALARS),
    contextWindow: 1_000_000_000
  };
}

interface Measurement<T> {
  readonly value: T;
  readonly timing: Timing;
  readonly rssGrowthBytes: number;
  readonly heapGrowthBytes: number;
}

async function measure<T>(run: () => Promise<T>): Promise<Measurement<T>> {
  const startedMemory = process.memoryUsage();
  let peakRss = startedMemory.rss;
  let peakHeap = startedMemory.heapUsed;
  const sampleMemory = (): void => {
    const current = process.memoryUsage();
    peakRss = Math.max(peakRss, current.rss);
    peakHeap = Math.max(peakHeap, current.heapUsed);
  };
  const sampler = setInterval(sampleMemory, 2);
  sampler.unref();
  const read = startTiming();
  try {
    const value = await run();
    const timing = read();
    sampleMemory();
    return {
      value,
      timing,
      rssGrowthBytes: Math.max(0, peakRss - startedMemory.rss),
      heapGrowthBytes: Math.max(0, peakHeap - startedMemory.heapUsed)
    };
  } finally {
    clearInterval(sampler);
  }
}

function assertPerformanceBound(
  context: { diagnostic(message: string): void },
  label: string,
  measurement: Measurement<unknown>,
  budget: Budget
): void {
  context.diagnostic(
    `${label}: ${formatMiB(measurement.rssGrowthBytes)}MiB peak RSS growth, `
    + `${formatMiB(measurement.heapGrowthBytes)}MiB peak heap growth`
  );
  assert.ok(
    measurement.rssGrowthBytes < MAX_RSS_GROWTH,
    `${label} grew RSS by ${formatMiB(measurement.rssGrowthBytes)}MiB`
  );
  assert.ok(
    measurement.heapGrowthBytes < MAX_HEAP_GROWTH,
    `${label} grew the heap by ${formatMiB(measurement.heapGrowthBytes)}MiB`
  );
  assertWithinBudget(context, label, budget, measurement.timing);
}

async function initializedFormat1Directory(
  t: { after(fn: () => Promise<void>): void },
  prefix: string
): Promise<string> {
  const dataDir = await makeDataDirectory(t, prefix);
  const lock = new DataDirectoryLock(dataDir, { initializeDataFormat: 1 });
  await lock.acquire();
  await lock.release();
  return dataDir;
}

async function makeDataDirectory(
  t: { after(fn: () => Promise<void>): void },
  prefix: string
): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function formatMiB(bytes: number): string {
  return (bytes / MIB).toFixed(2);
}
