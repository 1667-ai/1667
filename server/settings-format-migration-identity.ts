import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import {
  MutationLedgerFormatError,
  requireFm1Key,
  requireHash256
} from "./mutation-ledger-scalars.js";
import type {
  Fm1Key,
  Hash256,
  SettingsFormatMigrationV1SourceTag
} from "./mutation-ledger-types.js";

export const SETTINGS_FORMAT_MIGRATION_V1_SCHEMA = 1;
const FINGERPRINT_DOMAIN = "settings-format-migration-fingerprint-v1\0";

export interface SettingsFormatMigrationV1Identity {
  readonly key: Fm1Key;
  readonly fingerprintHash: Hash256;
  readonly sourceTag: SettingsFormatMigrationV1SourceTag;
  readonly canonicalV1Hash: Hash256;
}

export function settingsFormatMigrationV1Identity(
  sourceTagValue: SettingsFormatMigrationV1SourceTag,
  canonicalV1HashValue: Hash256
): SettingsFormatMigrationV1Identity {
  const sourceTag = requireSourceTag(sourceTagValue);
  const canonicalV1Hash = requireHash256(canonicalV1HashValue, "canonical v1 hash");
  return Object.freeze({
    key: deriveSettingsFormatMigrationV1Key(sourceTag, canonicalV1Hash),
    fingerprintHash: settingsFormatMigrationV1Fingerprint(sourceTag, canonicalV1Hash),
    sourceTag,
    canonicalV1Hash
  });
}

/** Exact logical key; its digest is RFC 4648 base64url without padding. */
export function deriveSettingsFormatMigrationV1Key(
  sourceTagValue: SettingsFormatMigrationV1SourceTag,
  canonicalV1HashValue: Hash256
): Fm1Key {
  const sourceTag = requireSourceTag(sourceTagValue);
  const canonicalV1Hash = requireHash256(canonicalV1HashValue, "canonical v1 hash");
  const digest = createHash("sha256")
    .update("settings-format-migration-v1\0", "utf8")
    .update(sourceTag, "utf8")
    .update("\0", "utf8")
    .update(canonicalV1Hash, "utf8")
    .digest("base64url");
  return requireFm1Key(`fm1:${digest}`);
}

/** Domain-separated JCS fingerprint binding schema, source kind, and source bytes. */
export function settingsFormatMigrationV1Fingerprint(
  sourceTagValue: SettingsFormatMigrationV1SourceTag,
  canonicalV1HashValue: Hash256
): Hash256 {
  const sourceTag = requireSourceTag(sourceTagValue);
  const canonicalV1Hash = requireHash256(canonicalV1HashValue, "canonical v1 hash");
  return createHash("sha256")
    .update(FINGERPRINT_DOMAIN, "utf8")
    .update(canonicalJson({
      migrationSchema: SETTINGS_FORMAT_MIGRATION_V1_SCHEMA,
      sourceTag,
      canonicalV1Hash
    }), "utf8")
    .digest("hex");
}

function requireSourceTag(value: unknown): SettingsFormatMigrationV1SourceTag {
  if (value !== "file" && value !== "absent-default") {
    throw new MutationLedgerFormatError("settings format migration source tag is invalid");
  }
  return value;
}
