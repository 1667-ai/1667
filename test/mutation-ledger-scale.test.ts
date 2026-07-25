import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { SETTINGS_STATE_V2_FILE } from "../server/data-directory-format.js";
import {
  formatMutationLedgerRecord,
  hashPreparedMutationRecord
} from "../server/mutation-ledger-codec.js";
import {
  MUTATION_LEDGER_DIRECTORY,
  userMutationLedgerSegments
} from "../server/mutation-ledger-paths.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import type {
  CompletedMutationRecord,
  MutationId,
  PreparedUserMutationRecord
} from "../server/mutation-ledger-types.js";
import { INITIAL_SETTINGS_STATE_V2_TEXT } from "../server/settings-v2-default.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const POPULATED_RECEIPT_COUNT = 1_025;

test("settings receipt lookup stays direct beyond 1,024 terminal receipts", {
  timeout: 60_000
}, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "1667-ledger-populated-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new MutationLedgerStore(dataDir);
  await store.init();

  const settingsFile = path.join(dataDir, SETTINGS_STATE_V2_FILE);
  await writeFile(settingsFile, INITIAL_SETTINGS_STATE_V2_TEXT, { mode: 0o600 });
  const settingsBytesBefore = await readFile(settingsFile);
  const history = await seedTerminalSettingsReceipts(dataDir, POPULATED_RECEIPT_COUNT);
  const expected = [
    history[0]!,
    history[Math.floor(history.length / 2)]!,
    history.at(-1)!
  ];

  const startedAt = performance.now();
  for (const entry of expected) {
    assert.deepEqual(
      await store.loadUserReceipt("settings", entry.prepared.key),
      { prepared: entry.prepared, completed: entry.completed }
    );
  }
  assert.deepEqual(
    await store.loadUserReceipt("settings", historyMutationId(POPULATED_RECEIPT_COUNT)),
    { prepared: null, completed: null }
  );
  const elapsed = performance.now() - startedAt;

  assert.deepEqual(await readFile(settingsFile), settingsBytesBefore);
  t.diagnostic(
    `${POPULATED_RECEIPT_COUNT.toLocaleString()} terminal receipts; `
      + `first/middle/last/missing direct lookups in ${elapsed.toFixed(1)}ms`
  );
  assert.ok(elapsed < 2_000, `populated direct receipt lookups took ${elapsed.toFixed(1)}ms`);
});

interface SeededTerminalSettingsReceipt {
  readonly prepared: PreparedUserMutationRecord;
  readonly completed: CompletedMutationRecord;
}

async function seedTerminalSettingsReceipts(
  dataDir: string,
  count: number
): Promise<readonly SeededTerminalSettingsReceipt[]> {
  const history = Array.from({ length: count }, (_, index) => {
    const prepared = preparedRecord(historyMutationId(index), index);
    return { prepared, completed: completedRecord(prepared) };
  });
  const root = path.join(dataDir, MUTATION_LEDGER_DIRECTORY);
  const parentDirectories = new Set(history.map(({ prepared }) => {
    const segments = userMutationLedgerSegments("settings", prepared.key);
    return path.join(root, ...segments.slice(0, -1));
  }));
  await Promise.all(
    [...parentDirectories].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 }))
  );

  const batchSize = 64;
  for (let offset = 0; offset < history.length; offset += batchSize) {
    await Promise.all(history.slice(offset, offset + batchSize).map(async ({ prepared, completed }) => {
      const directory = path.join(
        root,
        ...userMutationLedgerSegments("settings", prepared.key)
      );
      await mkdir(directory, { mode: 0o700 });
      await Promise.all([
        writeFile(
          path.join(directory, "prepared.json"),
          formatMutationLedgerRecord(prepared),
          { flag: "wx", mode: 0o600 }
        ),
        writeFile(
          path.join(directory, "completed.json"),
          formatMutationLedgerRecord(completed),
          { flag: "wx", mode: 0o600 }
        )
      ]);
    }));
  }
  return history;
}

function preparedRecord(key: MutationId, index: number): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key,
    fingerprintHash: HASH_A,
    method: "saveSettings",
    oldStateHash: HASH_A,
    newStateHash: HASH_B,
    startedRecordHash: null,
    result: {
      kind: "settings",
      settingsStateGeneration: index + 2,
      activeSettingsRevision: index + 2,
      pendingSettingsRevision: null
    },
    preparedAt: "2026-01-01T00:00:00.000Z"
  };
}

function completedRecord(prepared: PreparedUserMutationRecord): CompletedMutationRecord {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: "settings",
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt: "2026-01-01T00:00:01.000Z"
  };
}

function historyMutationId(index: number): MutationId {
  assert.ok(Number.isSafeInteger(index) && index >= 0);
  return `m1.1767225600000.${index.toString(16).padStart(32, "0")}` as MutationId;
}
