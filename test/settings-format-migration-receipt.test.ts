import assert from "node:assert/strict";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  formatMutationLedgerRecord,
  hashPreparedMutationRecord,
  parseMutationLedgerRecordText
} from "../server/mutation-ledger-codec.js";
import {
  formatMigrationLedgerSegments,
  MUTATION_LEDGER_DIRECTORY
} from "../server/mutation-ledger-paths.js";
import type { FormatMigrationReceiptRecord } from "../server/mutation-ledger-types.js";
import {
  deriveSettingsFormatMigrationV1Key,
  settingsFormatMigrationV1Fingerprint
} from "../server/settings-format-migration-identity.js";
import {
  completeSettingsFormatMigrationV1Receipt,
  prepareSettingsFormatMigrationV1Receipt,
  requireMatchingSettingsFormatMigrationV1Receipt
} from "../server/settings-format-migration-receipt.js";
import {
  HASH_A,
  HASH_B,
  hasCode,
  testStore
} from "./mutation-ledger-store-fixture.js";

const HASH_C = "c".repeat(64);
const PREPARED_AT = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2026-01-01T00:00:01.000Z";
const ABSENT_V1_HASH = "338c84ff15a6b5fb6566d339dcf611c3a420f1d817889277d0701aa56427c611";

test("format migration identity has fixed ADR003 key and schema-bound fingerprint vectors", () => {
  assert.equal(
    deriveSettingsFormatMigrationV1Key("file", HASH_A),
    "fm1:DiSgIJlUhMIh3WSCHQ3sOxmHEgsQDF_aNx4AuVlGQyY"
  );
  assert.equal(
    deriveSettingsFormatMigrationV1Key("absent-default", ABSENT_V1_HASH),
    "fm1:E3kuaP4uYaqnEaN4Czas0b0NrIahiCHoDXj47rISjg8"
  );
  assert.equal(
    settingsFormatMigrationV1Fingerprint("file", HASH_A),
    "68c9f2277965af12d8a4ba2b5bded7a261c6c679bc2baebcb7e5341bfc4237e6"
  );
  assert.equal(
    settingsFormatMigrationV1Fingerprint("absent-default", ABSENT_V1_HASH),
    "641836f0013f6b5d9833f1d7645c75fe28da6480da2990e5447aa3b71025a3de"
  );
  assert.notEqual(
    settingsFormatMigrationV1Fingerprint("file", HASH_A),
    settingsFormatMigrationV1Fingerprint("absent-default", HASH_A)
  );
});

test("format migration receipt construction binds source, fingerprint, and state", () => {
  const prepared = preparedRecord();
  assert.equal(prepared.oldStateHash, HASH_A);
  assert.equal(prepared.fingerprintHash, settingsFormatMigrationV1Fingerprint("file", HASH_A));
  assert.deepEqual(
    parseMutationLedgerRecordText(formatMutationLedgerRecord(prepared)),
    prepared
  );

  for (const invalid of [
    { ...prepared, fingerprintHash: HASH_C },
    { ...prepared, oldStateHash: HASH_C },
    {
      ...prepared,
      key: deriveSettingsFormatMigrationV1Key("absent-default", HASH_A)
    }
  ]) {
    assert.throws(() => formatMutationLedgerRecord(invalid));
  }

  assert.equal(
    requireMatchingSettingsFormatMigrationV1Receipt(prepared, {
      sourceTag: "file",
      canonicalV1Hash: HASH_A,
      newStateHash: HASH_B
    }),
    prepared
  );
  assert.throws(
    () => requireMatchingSettingsFormatMigrationV1Receipt(prepared, {
      sourceTag: "file",
      canonicalV1Hash: HASH_A,
      newStateHash: HASH_C
    }),
    hasCode("idempotency_conflict")
  );
});

test("format migration store writes exact immutable prepared and completed records", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-fm1-write-");
  const prepared = preparedRecord();
  const completed = completeSettingsFormatMigrationV1Receipt(prepared, COMPLETED_AT);

  await store.writeFormatMigrationRecord(prepared);
  await store.writeFormatMigrationRecord(prepared);
  await store.writeFormatMigrationRecord(completed);
  await store.writeFormatMigrationRecord(completed);
  assert.deepEqual(await store.loadFormatMigrationReceipt(prepared.key), { prepared, completed });

  const directory = path.join(
    dataDir,
    MUTATION_LEDGER_DIRECTORY,
    ...formatMigrationLedgerSegments(prepared.key)
  );
  if (process.platform !== "win32") {
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(directory, "prepared.json"))).mode & 0o777, 0o600);
    assert.equal((await lstat(path.join(directory, "completed.json"))).mode & 0o777, 0o600);
  }
  assert.equal((await readFile(path.join(directory, "prepared.json"), "utf8")).endsWith("\n"), false);

  await assert.rejects(
    store.writeFormatMigrationRecord({ ...prepared, newStateHash: HASH_C }),
    hasCode("idempotency_conflict")
  );
  await assert.rejects(
    store.writeFormatMigrationRecord({ ...completed, completedAt: "2026-01-01T00:00:02.000Z" }),
    hasCode("idempotency_conflict")
  );
});

test("format migration store preflights identity and completion order", async (t) => {
  const invalid = await testStore(t, "1667-ledger-fm1-invalid-");
  const prepared = preparedRecord();
  await assert.rejects(
    invalid.store.writeFormatMigrationRecord({
      ...prepared,
      fingerprintHash: HASH_C
    } as FormatMigrationReceiptRecord),
    hasCode("internal")
  );
  assert.deepEqual(await readdir(path.join(invalid.dataDir, MUTATION_LEDGER_DIRECTORY)), []);

  const outOfOrder = await testStore(t, "1667-ledger-fm1-order-");
  const completed = completeSettingsFormatMigrationV1Receipt(prepared, COMPLETED_AT);
  await assert.rejects(
    outOfOrder.store.writeFormatMigrationRecord(completed),
    hasCode("internal")
  );
  assert.deepEqual(await readdir(path.join(outOfOrder.dataDir, MUTATION_LEDGER_DIRECTORY)), []);

  await outOfOrder.store.writeFormatMigrationRecord(prepared);
  await assert.rejects(
    outOfOrder.store.writeFormatMigrationRecord({
      ...completed,
      preparedRecordHash: HASH_C
    }),
    hasCode("internal")
  );
  assert.equal(
    hashPreparedMutationRecord((await outOfOrder.store.loadFormatMigrationReceipt(prepared.key)).prepared!),
    completed.preparedRecordHash
  );
});

test("format migration store permits exactly one internal receipt identity", async (t) => {
  const { dataDir, store } = await testStore(t, "1667-ledger-fm1-single-");
  const prepared = preparedRecord();
  await store.writeFormatMigrationRecord(prepared);

  const changedSource = prepareSettingsFormatMigrationV1Receipt({
    sourceTag: "absent-default",
    canonicalV1Hash: HASH_A,
    newStateHash: HASH_B,
    preparedAt: PREPARED_AT
  });
  await assert.rejects(
    store.writeFormatMigrationRecord(changedSource),
    hasCode("idempotency_conflict")
  );
  assert.deepEqual(
    await readdir(path.join(dataDir, MUTATION_LEDGER_DIRECTORY, "settings", "internal")),
    [formatMigrationLedgerSegments(prepared.key)[2]]
  );
});

function preparedRecord() {
  return prepareSettingsFormatMigrationV1Receipt({
    sourceTag: "file",
    canonicalV1Hash: HASH_A,
    newStateHash: HASH_B,
    preparedAt: PREPARED_AT
  });
}
