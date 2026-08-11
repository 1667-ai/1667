import {
  assertNfcJsonStrings,
  canonicalJson,
  decodeCanonicalUtf8,
  encodeUtf8Strict
} from "./canonical-json.js";
import {
  MAX_MUTATION_LEDGER_RECORD_BYTES,
  MutationLedgerFormatError,
  requireHash256,
  requireLogicalAggregateKey,
  requireMutationId,
  requireTimeMs
} from "./mutation-ledger-scalars.js";
import type {
  AcknowledgedMutationRecord,
  CompletedMutationRecord,
  Fm1Key,
  MutationLedgerRecord,
  MutationResult,
  PreparedInternalMutationRecord,
  PreparedMutationRecord,
  PreparedProviderAcknowledgementRecord,
  PreparedRecord,
  PreparedUserMutationRecord,
  StartedMutationRecord
} from "./mutation-ledger-types.js";
import { isInternalMutationMethod, isProviderMutationMethod } from "./mutation-ledger-types.js";
import {
  parseMutationResult,
  requireDurableMethod,
  requireMutationLedgerKey,
  requireStoryAggregateKey,
  validatePreparedMutationMatrix,
  validateStoryMutationResult
} from "./mutation-ledger-validation.js";
import {
  hashMutationPreparedRecordBytes,
  hashMutationStartedRecordBytes
} from "./story-manifest-hash.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";

const STARTED = closedShape(
  ["schema", "kind", "aggregateKey", "mutationId", "fingerprintHash", "method", "oldStateHash", "createdAt"],
  ["imageObjectIds"]
);
/** Bounds `imageObjectIds`' length. Mirrors `shared/image-attachment.ts`'s
 * `MAX_ACTIVE_PROMPT_IMAGES`, the same active-prompt image count limit the
 * story side enforces, so this record can never grow anywhere near
 * `MAX_MUTATION_LEDGER_RECORD_BYTES` on account of this field. Duplicated
 * as a literal rather than imported: `shared/image-attachment.ts` is a
 * `shared/` module and this parser's other bounds are all local constants
 * of their own, so a literal keeps the layering consistent with the rest of
 * this file. */
const MAX_STARTED_IMAGE_OBJECT_IDS = 4;
const PREPARED_MUTATION = closedShape([
  "schema", "kind", "purpose", "aggregateKey", "key", "fingerprintHash", "method", "oldStateHash",
  "newStateHash", "startedRecordHash", "result", "preparedAt"
]);
const PREPARED_ACKNOWLEDGEMENT = closedShape([
  "schema", "kind", "purpose", "aggregateKey", "key", "fingerprintHash", "method", "oldStateHash",
  "newStateHash", "originalProviderMutationId", "originalStartedRecordHash", "result", "preparedAt"
]);
const COMPLETED = closedShape([
  "schema", "kind", "aggregateKey", "key", "preparedRecordHash", "completedAt"
]);
const ACKNOWLEDGED = closedShape([
  "schema", "kind", "aggregateKey", "mutationId", "startedRecordHash", "acknowledgementMutationId",
  "acknowledgementPreparedHash", "acknowledgedAt"
]);

export function parseMutationLedgerRecordBytes(bytes: Uint8Array): MutationLedgerRecord {
  if (bytes.byteLength > MAX_MUTATION_LEDGER_RECORD_BYTES) {
    throw new MutationLedgerFormatError(
      `Mutation ledger record exceeds its ${MAX_MUTATION_LEDGER_RECORD_BYTES}-byte size limit`
    );
  }
  let text: string;
  try {
    text = decodeCanonicalUtf8(bytes, "mutation ledger record");
  } catch (error) {
    throw new MutationLedgerFormatError("Mutation ledger record is not strict UTF-8", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new MutationLedgerFormatError("Mutation ledger record is not valid JSON", { cause: error });
  }
  let parsed: MutationLedgerRecord;
  try {
    parsed = parseRecord(value);
  } catch (error) {
    if (error instanceof MutationLedgerFormatError) throw error;
    const message = error instanceof Error ? error.message : "Mutation ledger record shape is invalid";
    throw new MutationLedgerFormatError(message, { cause: error });
  }
  try {
    assertNfcJsonStrings(value, "mutation ledger record");
  } catch (error) {
    throw new MutationLedgerFormatError("Mutation ledger record contains a non-NFC string", { cause: error });
  }
  if (canonicalJson(value) !== text) {
    throw new MutationLedgerFormatError("Mutation ledger record is not canonical JSON");
  }
  return deepFreeze(parsed);
}

export function parseMutationLedgerRecordText(text: string): MutationLedgerRecord {
  let bytes: Uint8Array;
  try {
    bytes = encodeUtf8Strict(text, "mutation ledger record");
  } catch (error) {
    throw new MutationLedgerFormatError("Mutation ledger record contains invalid Unicode", { cause: error });
  }
  return parseMutationLedgerRecordBytes(bytes);
}

/** Formatting is deliberately a validating operation, never a blind stringify. */
export function formatMutationLedgerRecord(record: MutationLedgerRecord): string {
  try {
    const text = canonicalJson(record);
    const parsed = parseMutationLedgerRecordText(text);
    return canonicalJson(parsed);
  } catch (error) {
    if (error instanceof MutationLedgerFormatError) throw error;
    throw new MutationLedgerFormatError("Mutation ledger record cannot be formatted", { cause: error });
  }
}

export function formatMutationLedgerRecordBytes(record: MutationLedgerRecord): Uint8Array {
  return Buffer.from(formatMutationLedgerRecord(record), "utf8");
}

export function hashStartedMutationRecord(record: StartedMutationRecord): string {
  return hashMutationStartedRecordBytes(formatMutationLedgerRecordBytes(record));
}

export function hashPreparedMutationRecord(record: PreparedRecord): string {
  return hashMutationPreparedRecordBytes(formatMutationLedgerRecordBytes(record));
}

function parseRecord(value: unknown): MutationLedgerRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationLedgerFormatError("Mutation ledger record must be an object");
  }
  const root = value as Record<string, unknown>;
  literal(root.schema, 1, "record.schema");
  switch (root.kind) {
    case "started": return parseStarted(value);
    case "prepared": return parsePrepared(value);
    case "completed": return parseCompleted(value);
    case "acknowledged": return parseAcknowledged(value);
    default: throw new MutationLedgerFormatError("record.kind is invalid");
  }
}

function parseStarted(value: unknown): StartedMutationRecord {
  const record = closedRecord(value, "started record", STARTED);
  literal(record.schema, 1, "started.schema");
  literal(record.kind, "started", "started.kind");
  const aggregateKey = requireStoryAggregateKey(record.aggregateKey);
  const method = requireDurableMethod(record.method);
  if (!isProviderMutationMethod(method)) {
    throw new MutationLedgerFormatError("Started records require a provider story method");
  }
  const imageObjectIds = parseStartedImageObjectIds(record.imageObjectIds);
  return {
    schema: 1,
    kind: "started",
    aggregateKey,
    mutationId: requireMutationId(record.mutationId),
    fingerprintHash: requireHash256(record.fingerprintHash, "started.fingerprintHash"),
    method,
    oldStateHash: requireHash256(record.oldStateHash, "started.oldStateHash"),
    createdAt: requireTimeMs(record.createdAt, "started.createdAt"),
    ...(imageObjectIds === undefined ? {} : { imageObjectIds })
  };
}

/** Absence means none. When present, non-empty and bounded, mirroring
 * `shared/image-attachment.ts`'s "absence means none, empty is invalid"
 * rule for the same reason: an empty array and an absent field would
 * otherwise be two on-disk encodings of the same fact. */
function parseStartedImageObjectIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new MutationLedgerFormatError("started.imageObjectIds must be a non-empty array when present");
  }
  if (value.length > MAX_STARTED_IMAGE_OBJECT_IDS) {
    throw new MutationLedgerFormatError(
      `started.imageObjectIds exceeds the ${MAX_STARTED_IMAGE_OBJECT_IDS}-entry limit`
    );
  }
  return value.map((entry, index) => requireHash256(entry, `started.imageObjectIds[${index}]`));
}

function parsePrepared(value: unknown): PreparedRecord {
  const candidate = value as Record<string, unknown>;
  if (candidate?.purpose === "mutation") return parsePreparedMutation(value);
  if (candidate?.purpose === "provider-acknowledgement") return parsePreparedAcknowledgement(value);
  throw new MutationLedgerFormatError("prepared.purpose is invalid");
}

function parsePreparedMutation(value: unknown): PreparedMutationRecord {
  const record = closedRecord(value, "prepared mutation record", PREPARED_MUTATION);
  literal(record.schema, 1, "prepared.schema");
  literal(record.kind, "prepared", "prepared.kind");
  literal(record.purpose, "mutation", "prepared.purpose");
  const aggregateKey = requireLogicalAggregateKey(record.aggregateKey);
  const method = requireDurableMethod(record.method);
  const key = requireMutationLedgerKey(record.key);
  const oldStateHash = record.oldStateHash === "absent"
    ? "absent"
    : requireHash256(record.oldStateHash, "prepared.oldStateHash");
  const startedRecordHash = record.startedRecordHash === null
    ? null
    : requireHash256(record.startedRecordHash, "prepared.startedRecordHash");
  const fingerprintHash = requireHash256(record.fingerprintHash, "prepared.fingerprintHash");
  const newStateHash = requireHash256(record.newStateHash, "prepared.newStateHash");
  const result = parseMutationResult(record.result);
  validatePreparedMutationMatrix({
    aggregateKey, key, method, fingerprintHash, oldStateHash, newStateHash, startedRecordHash, result
  });
  const common = {
    schema: 1,
    kind: "prepared",
    purpose: "mutation",
    fingerprintHash,
    newStateHash,
    preparedAt: requireTimeMs(record.preparedAt, "prepared.preparedAt")
  } as const;
  if (isInternalMutationMethod(method)) {
    return {
      ...common,
      aggregateKey: "settings",
      key: key as Fm1Key,
      method,
      oldStateHash: oldStateHash as string,
      startedRecordHash: null,
      result: result as Extract<MutationResult, { kind: "format-migration-v1" }>
    } satisfies PreparedInternalMutationRecord;
  }
  return {
    ...common,
    aggregateKey,
    key: key as string,
    method,
    oldStateHash,
    startedRecordHash,
    result
  } as PreparedUserMutationRecord;
}

function parsePreparedAcknowledgement(value: unknown): PreparedProviderAcknowledgementRecord {
  const record = closedRecord(value, "prepared acknowledgement record", PREPARED_ACKNOWLEDGEMENT);
  literal(record.schema, 1, "prepared.schema");
  literal(record.kind, "prepared", "prepared.kind");
  literal(record.purpose, "provider-acknowledgement", "prepared.purpose");
  literal(record.method, "acknowledgeUnknownOutcomes", "prepared.method");
  const aggregateKey = requireStoryAggregateKey(record.aggregateKey);
  const key = requireMutationId(record.key, "prepared.key");
  const originalProviderMutationId = requireMutationId(
    record.originalProviderMutationId,
    "prepared.originalProviderMutationId"
  );
  if (key === originalProviderMutationId) {
    throw new MutationLedgerFormatError("Acknowledgement and original provider mutation IDs must differ");
  }
  const result = parseMutationResult(record.result);
  if (result.kind !== "story") {
    throw new MutationLedgerFormatError("Provider acknowledgement requires a story result");
  }
  validateStoryMutationResult(result, aggregateKey, "acknowledgeUnknownOutcomes");
  const oldStateHash = requireHash256(record.oldStateHash, "prepared.oldStateHash");
  const newStateHash = requireHash256(record.newStateHash, "prepared.newStateHash");
  if (oldStateHash === newStateHash) {
    throw new MutationLedgerFormatError("Provider acknowledgement must install a new aggregate revision");
  }
  return {
    schema: 1,
    kind: "prepared",
    purpose: "provider-acknowledgement",
    aggregateKey,
    key,
    fingerprintHash: requireHash256(record.fingerprintHash, "prepared.fingerprintHash"),
    method: "acknowledgeUnknownOutcomes",
    oldStateHash,
    newStateHash,
    originalProviderMutationId,
    originalStartedRecordHash: requireHash256(
      record.originalStartedRecordHash,
      "prepared.originalStartedRecordHash"
    ),
    result,
    preparedAt: requireTimeMs(record.preparedAt, "prepared.preparedAt")
  };
}

function parseCompleted(value: unknown): CompletedMutationRecord {
  const record = closedRecord(value, "completed record", COMPLETED);
  literal(record.schema, 1, "completed.schema");
  literal(record.kind, "completed", "completed.kind");
  const aggregateKey = requireLogicalAggregateKey(record.aggregateKey);
  const key = requireMutationLedgerKey(record.key);
  if (key.startsWith("fm1:") && aggregateKey !== "settings") {
    throw new MutationLedgerFormatError("Internal completed records require the settings aggregate");
  }
  return {
    schema: 1,
    kind: "completed",
    aggregateKey,
    key,
    preparedRecordHash: requireHash256(record.preparedRecordHash, "completed.preparedRecordHash"),
    completedAt: requireTimeMs(record.completedAt, "completed.completedAt")
  };
}

function parseAcknowledged(value: unknown): AcknowledgedMutationRecord {
  const record = closedRecord(value, "acknowledged record", ACKNOWLEDGED);
  literal(record.schema, 1, "acknowledged.schema");
  literal(record.kind, "acknowledged", "acknowledged.kind");
  const aggregateKey = requireStoryAggregateKey(record.aggregateKey);
  const mutationId = requireMutationId(record.mutationId);
  const acknowledgementMutationId = requireMutationId(
    record.acknowledgementMutationId,
    "acknowledged.acknowledgementMutationId"
  );
  if (mutationId === acknowledgementMutationId) {
    throw new MutationLedgerFormatError("Acknowledgement and original provider mutation IDs must differ");
  }
  return {
    schema: 1,
    kind: "acknowledged",
    aggregateKey,
    mutationId,
    startedRecordHash: requireHash256(record.startedRecordHash, "acknowledged.startedRecordHash"),
    acknowledgementMutationId,
    acknowledgementPreparedHash: requireHash256(
      record.acknowledgementPreparedHash,
      "acknowledged.acknowledgementPreparedHash"
    ),
    acknowledgedAt: requireTimeMs(record.acknowledgedAt, "acknowledged.acknowledgedAt")
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
