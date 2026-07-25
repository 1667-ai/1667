import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { hashPreparedMutationRecord } from "../server/mutation-ledger-codec.js";
import {
  formatMigrationLedgerSegments,
  MUTATION_LEDGER_DIRECTORY,
  userMutationLedgerSegments
} from "../server/mutation-ledger-paths.js";
import { MutationLedgerStore } from "../server/mutation-ledger-store.js";
import {
  completeSettingsFormatMigrationV1Receipt,
  prepareSettingsFormatMigrationV1Receipt
} from "../server/settings-format-migration-receipt.js";
import { deriveSettingsFormatMigrationV1Key } from "../server/settings-format-migration-identity.js";
import type {
  CompletedMutationRecord,
  MutationId,
  PreparedInternalMutationRecord,
  PreparedUserMutationRecord
} from "../server/mutation-ledger-types.js";

export const ID = "m1.1767225600000.000102030405060708090a0b0c0d0e0f" as MutationId;
export const HASH_A = "a".repeat(64);
export const HASH_B = "b".repeat(64);
export const FM1_KEY = deriveSettingsFormatMigrationV1Key("file", HASH_A);

export function preparedRecord(): PreparedUserMutationRecord {
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key: ID,
    fingerprintHash: HASH_A,
    method: "saveSettings",
    oldStateHash: HASH_A,
    newStateHash: HASH_B,
    startedRecordHash: null,
    result: {
      kind: "settings",
      settingsStateGeneration: 2,
      activeSettingsRevision: 2,
      pendingSettingsRevision: null
    },
    preparedAt: "2026-01-01T00:00:00.000Z"
  };
}

export function completedRecord(
  prepared: PreparedUserMutationRecord
): CompletedMutationRecord {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: "settings",
    key: ID,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt: "2026-01-01T00:00:01.000Z"
  };
}

export function internalPreparedRecord(): PreparedInternalMutationRecord {
  return prepareSettingsFormatMigrationV1Receipt({
    sourceTag: "file",
    canonicalV1Hash: HASH_A,
    newStateHash: HASH_B,
    preparedAt: "2026-01-01T00:00:00.000Z"
  });
}

export function internalCompletedRecord(
  prepared: PreparedInternalMutationRecord
): CompletedMutationRecord {
  return completeSettingsFormatMigrationV1Receipt(prepared, "2026-01-01T00:00:01.000Z");
}

export async function createMigrationDirectory(dataDir: string): Promise<string> {
  let directory = path.join(dataDir, MUTATION_LEDGER_DIRECTORY);
  for (const segment of formatMigrationLedgerSegments(FM1_KEY)) {
    directory = path.join(directory, segment);
    await mkdir(directory, { mode: 0o700 });
  }
  return directory;
}

export async function createUserDirectory(dataDir: string): Promise<string> {
  let directory = path.join(dataDir, MUTATION_LEDGER_DIRECTORY);
  for (const segment of userMutationLedgerSegments("settings", ID)) {
    directory = path.join(directory, segment);
    await mkdir(directory, { mode: 0o700 });
  }
  return directory;
}

export async function testStore(
  t: Pick<TestContext, "after">,
  prefix: string
): Promise<{ dataDir: string; store: MutationLedgerStore }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new MutationLedgerStore(dataDir);
  await store.init();
  return { dataDir, store };
}

export function receiptDirectory(dataDir: string): string {
  const directory = path.join(
    dataDir,
    MUTATION_LEDGER_DIRECTORY,
    ...userMutationLedgerSegments("settings", ID)
  );
  assert.equal(
    directory,
    path.join(
      dataDir,
      MUTATION_LEDGER_DIRECTORY,
      "settings",
      "user",
      "20260101",
      "4b",
      ID
    )
  );
  return directory;
}

export function ancestorLedgerDirectories(dataDir: string): string[] {
  const directories = [path.join(dataDir, MUTATION_LEDGER_DIRECTORY)];
  for (const segment of userMutationLedgerSegments("settings", ID)) {
    directories.push(path.join(directories.at(-1)!, segment));
  }
  return directories;
}

export function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}

export function hasFsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && "code" in error && error.code === code;
}
