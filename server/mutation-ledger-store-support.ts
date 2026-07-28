import type { Stats } from "node:fs";
import { mkdir, opendir } from "node:fs/promises";
import path from "node:path";
import { sameFileIdentity } from "./data-directory-file-read.js";
import { DiagnosticServiceError, ServiceError } from "./errors.js";
import { MUTATION_RETENTION_MS } from "./mutation-id-policy.js";
import {
  formatMutationLedgerRecordBytes,
  hashStartedMutationRecord,
  parseMutationLedgerRecordBytes
} from "./mutation-ledger-codec.js";
import { userMutationLedgerSegments } from "./mutation-ledger-paths.js";
import {
  MAX_MUTATION_LEDGER_RECORD_BYTES,
  requireHash256
} from "./mutation-ledger-scalars.js";
import type {
  AcknowledgedMutationRecord,
  CompletedMutationRecord,
  FormatMigrationReceiptRecord,
  Hash256,
  MutationId,
  MutationLedgerRecord,
  PreparedInternalMutationRecord,
  PreparedRecord,
  StartedMutationRecord
} from "./mutation-ledger-types.js";
import {
  inspectPrivateDirectory as inspectPrivateDirectoryPath,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  syncPrivateDirectory as syncPrivateDirectoryPath,
  type PrivateFilePolicy
} from "./private-file-publication.js";

export const RECORD_FILES = {
  started: "started.json",
  prepared: "prepared.json",
  completed: "completed.json",
  acknowledged: "acknowledged.json"
} as const;
const MAX_RECEIPT_ENTRIES = Object.keys(RECORD_FILES).length;
const LEDGER_DIRECTORY_LABEL = "Mutation ledger directory";
export const LEDGER_RECORD_POLICY: PrivateFilePolicy = Object.freeze({
  label: "Mutation ledger record",
  maxBytes: MAX_MUTATION_LEDGER_RECORD_BYTES
});

export type UserPreparedRecord = Exclude<PreparedRecord, PreparedInternalMutationRecord>;
export type UserReceiptRecord = UserPreparedRecord | CompletedMutationRecord;
type StoryPreparedRecord = UserPreparedRecord & { readonly aggregateKey: `story:${string}` };
type StoryCompletedRecord = CompletedMutationRecord & { readonly aggregateKey: `story:${string}` };
export type StoryReceiptRecord =
  | StartedMutationRecord
  | StoryPreparedRecord
  | StoryCompletedRecord
  | AcknowledgedMutationRecord;

interface StoryReceiptShape {
  readonly started: StartedMutationRecord | null;
  readonly prepared: UserPreparedRecord | null;
  readonly completed: CompletedMutationRecord | null;
  readonly acknowledged: AcknowledgedMutationRecord | null;
}

/** Returns the inspected identity of the ensured directory. A caller may pass
 * that identity back as `provenDurable` on a later call: only the exact same
 * directory (same device and inode) skips the parent flush, so a pathname
 * whose directory was replaced — even by another valid private directory —
 * is flushed like a new one. */
export async function ensurePrivateDirectory(
  parent: string,
  name: string,
  provenDurable?: Stats
): Promise<Stats> {
  const target = path.join(parent, name);
  let created = false;
  try {
    await inspectPrivateDirectory(parent);
    await mkdir(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw receiptUnavailable(error);
  }
  try {
    const identity = await inspectPrivateDirectory(target);
    // Existing paths are flushed too: a prior failed barrier or process crash
    // must become durable before a child receipt record can be committed.
    // Only the identical directory the caller already proved durable skips
    // the flush — and never one this call just created.
    const proven = !created
      && provenDurable !== undefined
      && sameFileIdentity(provenDurable, identity);
    if (!proven) await syncPrivateDirectory(parent);
    return identity;
  } catch (error) {
    throw receiptUnavailable(error);
  }
}

export async function inspectPrivateDirectory(directory: string): Promise<Stats> {
  return await inspectPrivateDirectoryPath(directory, LEDGER_DIRECTORY_LABEL);
}

export function canonicalUserRecord(
  value: UserReceiptRecord
): Readonly<{ record: UserReceiptRecord; bytes: Uint8Array }> {
  let bytes: Uint8Array;
  let record: MutationLedgerRecord;
  try {
    bytes = formatMutationLedgerRecordBytes(value);
    record = parseMutationLedgerRecordBytes(bytes);
  } catch (error) {
    throw invalidUserRecord(error);
  }
  if (record.kind !== "prepared" && record.kind !== "completed") {
    throw invalidUserRecord();
  }
  if (record.key.startsWith("fm1:")) {
    throw new ServiceError(500, "Internal receipts require the migration ledger path", "internal");
  }
  try {
    userMutationLedgerSegments(record.aggregateKey, record.key);
  } catch (error) {
    throw invalidUserRecord(error);
  }
  return Object.freeze({ record: record as UserReceiptRecord, bytes });
}

export function canonicalStoryRecord(
  value: MutationLedgerRecord
): Readonly<{ record: StoryReceiptRecord; bytes: Uint8Array }> {
  let bytes: Uint8Array;
  let record: MutationLedgerRecord;
  try {
    bytes = formatMutationLedgerRecordBytes(value);
    record = parseMutationLedgerRecordBytes(bytes);
  } catch (error) {
    throw invalidUserRecord(error);
  }
  if (record.aggregateKey === "settings"
    || (record.kind !== "started" && record.kind !== "prepared"
      && record.kind !== "completed" && record.kind !== "acknowledged")) {
    throw invalidUserRecord();
  }
  const storyRecord = record as StoryReceiptRecord;
  const mutationId = storyRecordKey(storyRecord);
  try {
    userMutationLedgerSegments(storyRecord.aggregateKey, mutationId);
  } catch (error) {
    throw invalidUserRecord(error);
  }
  return Object.freeze({ record: storyRecord, bytes });
}

export function storyRecordKey(record: StoryReceiptRecord): MutationId {
  return record.kind === "started" || record.kind === "acknowledged"
    ? record.mutationId
    : record.key as MutationId;
}

export function requirePreparedStartedRelation(
  prepared: UserPreparedRecord,
  started: StartedMutationRecord | null,
  mutationId: MutationId
): void {
  if (prepared.purpose === "provider-acknowledgement"
    || (prepared.purpose === "mutation" && prepared.startedRecordHash === null)) {
    if (started !== null) throw corruptReceipt(mutationId);
    return;
  }
  if (started === null
    || prepared.startedRecordHash !== hashStartedMutationRecord(started)
    || prepared.method !== started.method
    || prepared.fingerprintHash !== started.fingerprintHash) {
    throw corruptReceipt(mutationId);
  }
}

export async function writeImmutableRecord(
  directory: string,
  record: StoryReceiptRecord | UserReceiptRecord | FormatMigrationReceiptRecord,
  bytes: Uint8Array
): Promise<void> {
  const file = path.join(directory, RECORD_FILES[record.kind]);
  let existing: Buffer | null;
  try {
    await inspectPrivateDirectory(directory);
    existing = await readOptionalPrivateFile(file, LEDGER_RECORD_POLICY);
  } catch (error) {
    throw receiptUnavailable(error);
  }
  if (existing !== null) {
    await acceptExistingImmutableRecord(file, directory, record, bytes, existing);
    return;
  }

  try {
    await publishPrivateFileNoReplace(file, bytes, LEDGER_RECORD_POLICY);
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) {
      await acceptExistingImmutableRecord(file, directory, record, bytes);
      return;
    }
    if (await existingBytesEqual(file, bytes)) {
      try {
        await syncPrivateDirectory(directory);
        return;
      } catch (syncError) {
        throw receiptUnavailable(syncError);
      }
    }
    throw receiptUnavailable(error);
  }
}

async function acceptExistingImmutableRecord(
  file: string,
  directory: string,
  expected: StoryReceiptRecord | UserReceiptRecord | FormatMigrationReceiptRecord,
  expectedBytes: Uint8Array,
  recoveredBytes?: Uint8Array
): Promise<void> {
  let existingBytes: Uint8Array | null;
  try {
    existingBytes = recoveredBytes
      ?? await readOptionalPrivateFile(file, LEDGER_RECORD_POLICY);
  } catch (error) {
    throw receiptUnavailable(error);
  }
  if (existingBytes === null) {
    throw receiptUnavailable(new Error("Immutable mutation ledger record disappeared"));
  }
  if (Buffer.from(existingBytes).equals(Buffer.from(expectedBytes))) {
    try {
      await syncPrivateDirectory(directory);
      return;
    } catch (error) {
      throw receiptUnavailable(error);
    }
  }
  let existing: MutationLedgerRecord;
  try {
    existing = parseMutationLedgerRecordBytes(existingBytes);
  } catch (error) {
    throw receiptUnavailable(error);
  }
  const key = "key" in existing ? existing.key : existing.mutationId;
  const expectedKey = "key" in expected ? expected.key : expected.mutationId;
  if (existing.kind !== expected.kind
    || existing.aggregateKey !== expected.aggregateKey
    || key !== expectedKey) {
    throw receiptUnavailable(new Error("Mutation ledger record identity does not match its path"));
  }
  throw new ServiceError(
    409,
    "Mutation ID was already used with different receipt data",
    "idempotency_conflict"
  );
}

async function existingBytesEqual(file: string, expected: Uint8Array): Promise<boolean> {
  try {
    const actual = await readOptionalPrivateFile(file, LEDGER_RECORD_POLICY);
    return actual !== null && Buffer.from(actual).equals(Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function boundedReceiptEntries(
  directory: string,
  mutationId: MutationId
): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    handle = await opendir(directory);
    const entries: string[] = [];
    for (;;) {
      const entry = await handle.read();
      if (entry === null) break;
      entries.push(entry.name);
      if (entries.length > MAX_RECEIPT_ENTRIES) throw corruptReceipt(mutationId);
    }
    return entries.sort();
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw corruptReceipt(mutationId, error);
  } finally {
    try { await handle?.close(); } catch { /* preserve the primary read failure */ }
  }
}

export async function requireOnlyFormatMigrationEntry(
  parent: string,
  expected: string,
  allowAbsent: boolean
): Promise<void> {
  const entries = await boundedReceiptEntries(parent, expected);
  if ((allowAbsent && entries.length === 0)
    || (entries.length === 1 && entries[0] === expected)) return;
  throw new ServiceError(
    409,
    "A different settings format migration receipt already exists.",
    "idempotency_conflict"
  );
}

export async function syncPrivateDirectory(directory: string): Promise<void> {
  await syncPrivateDirectoryPath(directory, LEDGER_DIRECTORY_LABEL);
}

export function receiptUnavailable(cause: unknown): ServiceError {
  return new DiagnosticServiceError(
    503,
    "Mutation receipt storage is unavailable.",
    "receipt_storage_unavailable",
    cause
  );
}

export function corruptReceipt(mutationId: string, cause?: unknown): ServiceError {
  const error = new ServiceError(500, `Mutation receipt is corrupt: ${mutationId}`, "internal");
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function invalidUserRecord(cause?: unknown): ServiceError {
  const error = new ServiceError(500, "Mutation receipt record is invalid", "internal");
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function hash256Value(value: unknown): Hash256 {
  try {
    return requireHash256(value, "prepared record hash");
  } catch (error) {
    throw invalidUserRecord(error);
  }
}

export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function receiptExpired(timestampValue: string, nowMs: number): boolean {
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error("Mutation receipt collector clock returned an invalid time");
  }
  const terminalAt = Date.parse(timestampValue);
  if (!Number.isSafeInteger(terminalAt)) {
    throw new Error("Mutation receipt has an invalid terminal timestamp");
  }
  return terminalAt <= nowMs - MUTATION_RETENTION_MS;
}

export function laterTimestamp(left: string, right: string): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isSafeInteger(leftMs) || !Number.isSafeInteger(rightMs)) {
    throw new Error("Mutation receipt has an invalid terminal timestamp");
  }
  return leftMs >= rightMs ? left : right;
}

export function storyReceiptEntries(receipt: StoryReceiptShape): string[] {
  return [
    ...(receipt.started === null ? [] : [RECORD_FILES.started]),
    ...(receipt.prepared === null ? [] : [RECORD_FILES.prepared]),
    ...(receipt.completed === null ? [] : [RECORD_FILES.completed]),
    ...(receipt.acknowledged === null ? [] : [RECORD_FILES.acknowledged])
  ];
}
