import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { ServiceError } from "./errors.js";
import type { Hash256, MutationId } from "./mutation-ledger-types.js";
import {
  requireHash256,
  requireMutationId,
  MutationLedgerFormatError
} from "./mutation-ledger-scalars.js";
import {
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  type PrivateFilePolicy
} from "./private-file-publication.js";
import { isMintedSecretId } from "./settings-secret-ids.js";
import { closedRecord, closedShape, literal } from "./story-wire-validation.js";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.js";
import { decodeCanonicalUtf8, encodeUtf8Strict } from "./canonical-json.js";

export const SETTINGS_PENDING_SECRETS_FILE = "settings-pending-secrets-v1.json";
export const SETTINGS_PENDING_SECRETS_KIND = "settings-pending-secrets-v1" as const;

const MAX_OWNED_SECRET_IDS = 64;
const POLICY: PrivateFilePolicy = Object.freeze({
  label: "Settings pending secrets ownership",
  maxBytes: 32 * 1024
});

const RECORD = closedShape([
  "schema",
  "kind",
  "sourceStateHash",
  "mutationId",
  "candidateHash",
  "mintedSecretIds"
]);

export interface SettingsPendingSecretsV1 {
  readonly schema: 1;
  readonly kind: typeof SETTINGS_PENDING_SECRETS_KIND;
  readonly sourceStateHash: Hash256;
  readonly mutationId: MutationId;
  readonly candidateHash: Hash256;
  readonly mintedSecretIds: readonly string[];
}

export function settingsPendingSecretsPath(dataDir: string): string {
  return path.join(dataDir, SETTINGS_PENDING_SECRETS_FILE);
}

export function parseSettingsPendingSecretsV1(value: unknown): SettingsPendingSecretsV1 {
  const root = closedRecord(value, "settings pending secrets", RECORD);
  literal(root.schema, 1, "settings pending secrets.schema");
  literal(root.kind, SETTINGS_PENDING_SECRETS_KIND, "settings pending secrets.kind");
  const mintedSecretIds = parseMintedSecretIds(root.mintedSecretIds);
  return Object.freeze({
    schema: 1,
    kind: SETTINGS_PENDING_SECRETS_KIND,
    sourceStateHash: requireHash256(root.sourceStateHash, "settings pending secrets.sourceStateHash"),
    mutationId: requireMutationId(root.mutationId, "settings pending secrets.mutationId"),
    candidateHash: requireHash256(root.candidateHash, "settings pending secrets.candidateHash"),
    mintedSecretIds
  });
}

export function settingsPendingSecretsV1Identity(
  record: SettingsPendingSecretsV1
): Hash256 {
  return createHash("sha256")
    .update("settings-pending-secrets-v1\0", "utf8")
    .update(canonicalJson({
      sourceStateHash: record.sourceStateHash,
      mutationId: record.mutationId,
      candidateHash: record.candidateHash,
      mintedSecretIds: record.mintedSecretIds
    }), "utf8")
    .digest("hex");
}

export async function readSettingsPendingSecretsV1(
  dataDir: string
): Promise<SettingsPendingSecretsV1 | null> {
  const bytes = await readOptionalPrivateFile(settingsPendingSecretsPath(dataDir), POLICY);
  if (bytes === null) return null;
  const text = decodeCanonicalUtf8(bytes, "settings pending secrets");
  const value = parseJsonRejectingDuplicateKeys(text, "settings pending secrets");
  const record = parseSettingsPendingSecretsV1(value);
  if (canonicalJson(record) !== text) {
    throw new MutationLedgerFormatError("settings pending secrets is not canonical JSON");
  }
  return record;
}

export async function writeSettingsPendingSecretsV1(
  dataDir: string,
  record: SettingsPendingSecretsV1
): Promise<void> {
  const parsed = parseSettingsPendingSecretsV1(record);
  const bytes = encodeUtf8Strict(canonicalJson(parsed), "settings pending secrets");
  await publishPrivateFileNoReplace(settingsPendingSecretsPath(dataDir), bytes, POLICY);
}

export async function removeSettingsPendingSecretsV1(dataDir: string): Promise<void> {
  await removePrivateFile(settingsPendingSecretsPath(dataDir), POLICY);
}

export function requireMatchingPendingSecrets(
  record: SettingsPendingSecretsV1,
  expected: Omit<SettingsPendingSecretsV1, "schema" | "kind">
): void {
  if (
    record.sourceStateHash !== expected.sourceStateHash
    || record.mutationId !== expected.mutationId
    || record.candidateHash !== expected.candidateHash
    || canonicalJson(record.mintedSecretIds) !== canonicalJson(expected.mintedSecretIds)
  ) {
    throw new ServiceError(
      409,
      "Settings pending-secret ownership does not match this mutation.",
      "mutation_outcome_unknown"
    );
  }
}

function parseMintedSecretIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new MutationLedgerFormatError("settings pending secrets.mintedSecretIds must be an array");
  }
  if (value.length > MAX_OWNED_SECRET_IDS) {
    throw new MutationLedgerFormatError(
      `settings pending secrets.mintedSecretIds exceeds ${MAX_OWNED_SECRET_IDS} entries`
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !isMintedSecretId(entry)) {
      throw new MutationLedgerFormatError(
        "settings pending secrets.mintedSecretIds may contain only IDs minted by this project"
      );
    }
    if (seen.has(entry)) {
      throw new MutationLedgerFormatError("settings pending secrets.mintedSecretIds must be unique");
    }
    seen.add(entry);
    ids.push(entry);
  }
  return Object.freeze(ids);
}
