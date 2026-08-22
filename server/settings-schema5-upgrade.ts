import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson, decodeCanonicalUtf8, encodeUtf8Strict } from "./canonical-json.js";
import { ServiceError } from "./errors.js";
import type { Hash256, MutationId, TimeMs } from "./mutation-ledger-types.js";
import {
  MutationLedgerFormatError,
  requireHash256,
  requireMutationId,
  requireTimeMs
} from "./mutation-ledger-scalars.js";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";

export const SETTINGS_SCHEMA5_UPGRADE_KIND = "settings-schema5-upgrade-v1" as const;
export const SETTINGS_SCHEMA5_UPGRADE_PREPARED_FILE = "settings-schema5-upgrade-v1.json";
export const SETTINGS_SCHEMA5_UPGRADE_COMPLETED_FILE = "settings-schema5-upgrade-v1.completed.json";

const POLICY: PrivateFilePolicy = Object.freeze({
  label: "Settings schema-5 upgrade receipt",
  maxBytes: 8 * 1024
});

const PREPARED = closedShape([
  "schema",
  "kind",
  "phase",
  "sourceSchemaVersion",
  "sourceStateHash",
  "candidateStateHash",
  "mutationId",
  "fingerprintHash",
  "preparedAt"
]);

const COMPLETED = closedShape([
  "schema",
  "kind",
  "phase",
  "preparedRecordHash",
  "completedAt"
]);

export type SettingsSchema5SourceVersion = 2 | 3 | 4;

export interface SettingsSchema5UpgradeV1Prepared {
  readonly schema: 1;
  readonly kind: typeof SETTINGS_SCHEMA5_UPGRADE_KIND;
  readonly phase: "prepared";
  readonly sourceSchemaVersion: SettingsSchema5SourceVersion;
  readonly sourceStateHash: Hash256;
  readonly candidateStateHash: Hash256;
  readonly mutationId: MutationId;
  readonly fingerprintHash: Hash256;
  readonly preparedAt: TimeMs;
}

export interface SettingsSchema5UpgradeV1Completed {
  readonly schema: 1;
  readonly kind: typeof SETTINGS_SCHEMA5_UPGRADE_KIND;
  readonly phase: "completed";
  readonly preparedRecordHash: Hash256;
  readonly completedAt: TimeMs;
}

export interface SettingsSchema5UpgradeV1Identity {
  readonly sourceSchemaVersion: SettingsSchema5SourceVersion;
  readonly sourceStateHash: Hash256;
  readonly candidateStateHash: Hash256;
  readonly mutationId: MutationId;
  readonly fingerprintHash: Hash256;
}

export function settingsSchema5UpgradePreparedPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_SCHEMA5_UPGRADE_PREPARED_FILE);
}

export function settingsSchema5UpgradeCompletedPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_SCHEMA5_UPGRADE_COMPLETED_FILE);
}

export function settingsSchema5UpgradeV1Identity(
  sourceSchemaVersion: SettingsSchema5SourceVersion,
  sourceStateHash: string,
  candidateStateHash: string,
  mutationId: string
): SettingsSchema5UpgradeV1Identity {
  const source = requireSourceSchemaVersion(sourceSchemaVersion);
  const sourceHash = requireHash256(sourceStateHash, "schema-5 upgrade sourceStateHash");
  const candidateHash = requireHash256(candidateStateHash, "schema-5 upgrade candidateStateHash");
  const mutation = requireMutationId(mutationId, "schema-5 upgrade mutationId");
  return Object.freeze({
    sourceSchemaVersion: source,
    sourceStateHash: sourceHash,
    candidateStateHash: candidateHash,
    mutationId: mutation,
    fingerprintHash: settingsSchema5UpgradeV1Fingerprint(
      source,
      sourceHash,
      candidateHash,
      mutation
    )
  });
}

export function settingsSchema5UpgradeV1Fingerprint(
  sourceSchemaVersion: SettingsSchema5SourceVersion,
  sourceStateHash: Hash256,
  candidateStateHash: Hash256,
  mutationId: MutationId
): Hash256 {
  return createHash("sha256")
    .update("settings-schema5-upgrade-v1\0", "utf8")
    .update(canonicalJson({
      sourceSchemaVersion,
      sourceStateHash,
      candidateStateHash,
      mutationId
    }), "utf8")
    .digest("hex");
}

export function prepareSettingsSchema5UpgradeV1(
  identity: SettingsSchema5UpgradeV1Identity,
  preparedAt: TimeMs
): SettingsSchema5UpgradeV1Prepared {
  return Object.freeze({
    schema: 1,
    kind: SETTINGS_SCHEMA5_UPGRADE_KIND,
    phase: "prepared",
    sourceSchemaVersion: identity.sourceSchemaVersion,
    sourceStateHash: identity.sourceStateHash,
    candidateStateHash: identity.candidateStateHash,
    mutationId: identity.mutationId,
    fingerprintHash: identity.fingerprintHash,
    preparedAt
  });
}

export function completeSettingsSchema5UpgradeV1(
  prepared: SettingsSchema5UpgradeV1Prepared,
  completedAt: TimeMs
): SettingsSchema5UpgradeV1Completed {
  return Object.freeze({
    schema: 1,
    kind: SETTINGS_SCHEMA5_UPGRADE_KIND,
    phase: "completed",
    preparedRecordHash: hashSettingsSchema5UpgradePrepared(prepared),
    completedAt
  });
}

export function hashSettingsSchema5UpgradePrepared(
  prepared: SettingsSchema5UpgradeV1Prepared
): Hash256 {
  return createHash("sha256")
    .update("settings-schema5-upgrade-prepared-v1\0", "utf8")
    .update(canonicalJson(prepared), "utf8")
    .digest("hex");
}

export function parseSettingsSchema5UpgradePrepared(
  value: unknown
): SettingsSchema5UpgradeV1Prepared {
  const root = closedRecord(value, "schema-5 upgrade prepared receipt", PREPARED);
  literal(root.schema, 1, "schema-5 upgrade.schema");
  literal(root.kind, SETTINGS_SCHEMA5_UPGRADE_KIND, "schema-5 upgrade.kind");
  literal(root.phase, "prepared", "schema-5 upgrade.phase");
  const identity = settingsSchema5UpgradeV1Identity(
    requireSourceSchemaVersion(root.sourceSchemaVersion),
    String(root.sourceStateHash),
    String(root.candidateStateHash),
    String(root.mutationId)
  );
  if (root.fingerprintHash !== identity.fingerprintHash) {
    throw new MutationLedgerFormatError("schema-5 upgrade fingerprint does not bind its identity");
  }
  return Object.freeze({
    ...identity,
    schema: 1,
    kind: SETTINGS_SCHEMA5_UPGRADE_KIND,
    phase: "prepared",
    preparedAt: requireTimeMs(root.preparedAt, "schema-5 upgrade.preparedAt")
  });
}

export function parseSettingsSchema5UpgradeCompleted(
  value: unknown
): SettingsSchema5UpgradeV1Completed {
  const root = closedRecord(value, "schema-5 upgrade completed receipt", COMPLETED);
  literal(root.schema, 1, "schema-5 upgrade.schema");
  literal(root.kind, SETTINGS_SCHEMA5_UPGRADE_KIND, "schema-5 upgrade.kind");
  literal(root.phase, "completed", "schema-5 upgrade.phase");
  return Object.freeze({
    schema: 1,
    kind: SETTINGS_SCHEMA5_UPGRADE_KIND,
    phase: "completed",
    preparedRecordHash: requireHash256(
      root.preparedRecordHash,
      "schema-5 upgrade.preparedRecordHash"
    ),
    completedAt: requireTimeMs(root.completedAt, "schema-5 upgrade.completedAt")
  });
}

export async function readSettingsSchema5UpgradePrepared(
  dataDir: string
): Promise<SettingsSchema5UpgradeV1Prepared | null> {
  return await readCanonicalRecord(
    settingsSchema5UpgradePreparedPath(dataDir),
    parseSettingsSchema5UpgradePrepared
  );
}

export async function readSettingsSchema5UpgradeCompleted(
  dataDir: string
): Promise<SettingsSchema5UpgradeV1Completed | null> {
  return await readCanonicalRecord(
    settingsSchema5UpgradeCompletedPath(dataDir),
    parseSettingsSchema5UpgradeCompleted
  );
}

export async function writeSettingsSchema5UpgradePrepared(
  dataDir: string,
  prepared: SettingsSchema5UpgradeV1Prepared
): Promise<void> {
  const parsed = parseSettingsSchema5UpgradePrepared(prepared);
  await publishPrivateFileNoReplace(
    settingsSchema5UpgradePreparedPath(dataDir),
    encodeUtf8Strict(canonicalJson(parsed), "schema-5 upgrade prepared receipt"),
    POLICY
  );
}

export async function writeSettingsSchema5UpgradeCompleted(
  dataDir: string,
  completed: SettingsSchema5UpgradeV1Completed
): Promise<void> {
  const parsed = parseSettingsSchema5UpgradeCompleted(completed);
  await publishPrivateFileNoReplace(
    settingsSchema5UpgradeCompletedPath(dataDir),
    encodeUtf8Strict(canonicalJson(parsed), "schema-5 upgrade completed receipt"),
    POLICY
  );
}

export async function removeSettingsSchema5UpgradeReceipts(dataDir: string): Promise<void> {
  await removePrivateFile(settingsSchema5UpgradePreparedPath(dataDir), POLICY);
  await removePrivateFile(settingsSchema5UpgradeCompletedPath(dataDir), POLICY);
}

export function requireMatchingSettingsSchema5Upgrade(
  prepared: SettingsSchema5UpgradeV1Prepared,
  identity: SettingsSchema5UpgradeV1Identity
): void {
  if (
    prepared.sourceSchemaVersion !== identity.sourceSchemaVersion
    || prepared.sourceStateHash !== identity.sourceStateHash
    || prepared.candidateStateHash !== identity.candidateStateHash
    || prepared.mutationId !== identity.mutationId
    || prepared.fingerprintHash !== identity.fingerprintHash
  ) {
    throw new ServiceError(
      409,
      "Settings schema-5 upgrade input changed after its receipt was prepared.",
      "idempotency_conflict"
    );
  }
}

export function unmatchedSchema5NextError(): ServiceError {
  return new ServiceError(
    409,
    "A schema-5 settings replacement is staged without its matching upgrade receipt; current settings were not changed.",
    "mutation_outcome_unknown"
  );
}

function requireSourceSchemaVersion(value: unknown): SettingsSchema5SourceVersion {
  if (value !== 2 && value !== 3 && value !== 4) {
    throw new MutationLedgerFormatError("schema-5 upgrade sourceSchemaVersion is invalid");
  }
  return value;
}

async function readCanonicalRecord<T>(
  file: string,
  parse: (value: unknown) => T
): Promise<T | null> {
  const bytes = await readOptionalPrivateFile(file, POLICY);
  if (bytes === null) return null;
  const text = decodeCanonicalUtf8(bytes, "schema-5 upgrade receipt");
  const value = parseJsonRejectingDuplicateKeys(text, "schema-5 upgrade receipt");
  const record = parse(value);
  if (canonicalJson(record) !== text) {
    throw new MutationLedgerFormatError("schema-5 upgrade receipt is not canonical JSON");
  }
  return record;
}
