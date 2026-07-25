import { ServiceError } from "./errors.js";
import {
  formatMutationLedgerRecordBytes,
  hashPreparedMutationRecord,
  parseMutationLedgerRecordBytes
} from "./mutation-ledger-codec.js";
import { formatMigrationLedgerSegments } from "./mutation-ledger-paths.js";
import { MutationLedgerFormatError } from "./mutation-ledger-scalars.js";
import type {
  CompletedInternalMutationRecord,
  FormatMigrationReceiptRecord,
  Hash256,
  PreparedInternalMutationRecord,
  SettingsFormatMigrationV1SourceTag,
  TimeMs
} from "./mutation-ledger-types.js";
import { settingsFormatMigrationV1Identity } from "./settings-format-migration-identity.js";

export interface PrepareSettingsFormatMigrationV1Receipt {
  readonly sourceTag: SettingsFormatMigrationV1SourceTag;
  readonly canonicalV1Hash: Hash256;
  readonly newStateHash: Hash256;
  readonly preparedAt: TimeMs;
}

export function canonicalFormatMigrationReceiptRecord(
  value: FormatMigrationReceiptRecord
): Readonly<{ record: FormatMigrationReceiptRecord; bytes: Uint8Array }> {
  const bytes = formatMutationLedgerRecordBytes(value);
  const record = parseMutationLedgerRecordBytes(bytes);
  if (record.kind === "prepared") {
    if (record.method !== "migrateSettingsFormatV1") {
      throw new MutationLedgerFormatError("format migration prepared record is invalid");
    }
  } else if (record.kind !== "completed"
    || record.aggregateKey !== "settings"
    || !record.key.startsWith("fm1:")) {
    throw new MutationLedgerFormatError("format migration completed record is invalid");
  }
  formatMigrationLedgerSegments(record.key);
  return Object.freeze({ record: record as FormatMigrationReceiptRecord, bytes });
}

export function prepareSettingsFormatMigrationV1Receipt(
  input: PrepareSettingsFormatMigrationV1Receipt
): PreparedInternalMutationRecord {
  const identity = settingsFormatMigrationV1Identity(input.sourceTag, input.canonicalV1Hash);
  return {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    aggregateKey: "settings",
    key: identity.key,
    fingerprintHash: identity.fingerprintHash,
    method: "migrateSettingsFormatV1",
    oldStateHash: identity.canonicalV1Hash,
    newStateHash: input.newStateHash,
    startedRecordHash: null,
    result: {
      kind: "format-migration-v1",
      sourceTag: identity.sourceTag,
      canonicalV1Hash: identity.canonicalV1Hash
    },
    preparedAt: input.preparedAt
  };
}

export function completeSettingsFormatMigrationV1Receipt(
  prepared: PreparedInternalMutationRecord,
  completedAt: TimeMs
): CompletedInternalMutationRecord {
  return {
    schema: 1,
    kind: "completed",
    aggregateKey: "settings",
    key: prepared.key,
    preparedRecordHash: hashPreparedMutationRecord(prepared),
    completedAt
  };
}

export function requireMatchingSettingsFormatMigrationV1Receipt(
  prepared: PreparedInternalMutationRecord,
  expected: Omit<PrepareSettingsFormatMigrationV1Receipt, "preparedAt">
): PreparedInternalMutationRecord {
  const identity = settingsFormatMigrationV1Identity(expected.sourceTag, expected.canonicalV1Hash);
  if (prepared.key !== identity.key
    || prepared.fingerprintHash !== identity.fingerprintHash
    || prepared.oldStateHash !== identity.canonicalV1Hash
    || prepared.newStateHash !== expected.newStateHash
    || prepared.result.sourceTag !== identity.sourceTag
    || prepared.result.canonicalV1Hash !== identity.canonicalV1Hash) {
    throw new ServiceError(
      409,
      "Settings format migration input changed after its receipt was prepared.",
      "idempotency_conflict"
    );
  }
  return prepared;
}
