import path from "node:path";
import type { GenerationSettings } from "../shared/types.js";
import {
  SETTINGS_STATE_V1_FILE,
  SETTINGS_STATE_V1_NEXT_FILE
} from "./data-directory-layout.js";
import { readBoundedRegularFile } from "./data-directory-file-read.js";
import { ServiceError } from "./errors.js";
import {
  ABSENT_SETTINGS_V1,
  ABSENT_SETTINGS_V1_HASH,
  hashCanonicalGenerationSettingsV1,
  parseGenerationSettingsV1Bytes
} from "./settings-v1-codec.js";
import { MAX_SETTINGS_DOCUMENT_BYTES } from "./settings-v2-scalars.js";
import {
  publishSettingsFile,
  readOptionalSettingsFile,
  removeSettingsFile
} from "./settings-file-io.js";

/**
 * Resolve the complete format-1 final/temp matrix. Both-absent is the frozen
 * virtual vector; malformed or unsafe residue never falls back to defaults.
 */
export async function loadGenerationSettingsV1(dataDir: string): Promise<GenerationSettings> {
  return (await loadGenerationSettingsV1Source(dataDir)).settings;
}

export interface GenerationSettingsV1Source {
  readonly settings: GenerationSettings;
  readonly sourceTag: "file" | "absent-default";
  readonly canonicalV1Hash: string;
}

/**
 * Recover format-1 authority and retain the provenance needed by Release B's
 * durable migration identity. Historical whitespace never affects the hash.
 */
export async function loadGenerationSettingsV1Source(
  dataDir: string
): Promise<GenerationSettingsV1Source> {
  const finalFile = path.join(dataDir, SETTINGS_STATE_V1_FILE);
  const nextFile = path.join(dataDir, SETTINGS_STATE_V1_NEXT_FILE);
  try {
    const [finalBytes, nextBytes] = await Promise.all([
      readOptionalSettingsFile(finalFile, MAX_SETTINGS_DOCUMENT_BYTES, { allowLegacyReadMode: true }),
      readOptionalSettingsFile(nextFile, MAX_SETTINGS_DOCUMENT_BYTES, { allowLegacyReadMode: true })
    ]);
    const finalSettings = finalBytes === null ? null : parseGenerationSettingsV1Bytes(finalBytes);
    const nextSettings = nextBytes === null ? null : parseGenerationSettingsV1Bytes(nextBytes);

    if (finalSettings !== null) {
      if (nextSettings !== null) {
        await removeSettingsFile(nextFile, { allowLegacyReadMode: true });
      }
      return source(finalSettings, "file");
    }
    if (nextSettings !== null) {
      await publishSettingsFile(nextFile, finalFile);
      return source(nextSettings, "file");
    }
    return Object.freeze({
      settings: ABSENT_SETTINGS_V1,
      sourceTag: "absent-default",
      canonicalV1Hash: ABSENT_SETTINGS_V1_HASH
    });
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      500,
      "Format-1 settings are malformed or unsafe; no defaults were substituted.",
      "internal"
    );
  }
}

/**
 * Release B's read-only source commit fence. Initial recovery guarantees one
 * of these exact matrices; any later final/temp appearance, disappearance, or
 * byte change is source drift and must remain untouched for diagnosis.
 */
export async function assertGenerationSettingsV1SourceUnchanged(
  dataDir: string,
  expected: Pick<GenerationSettingsV1Source, "sourceTag" | "canonicalV1Hash">
): Promise<void> {
  const current = await readGenerationSettingsV1SourceSnapshot(dataDir);
  if (current.sourceTag !== expected.sourceTag
    || current.canonicalV1Hash !== expected.canonicalV1Hash) {
    throw sourceChanged();
  }
}

/**
 * Read a previously recovered format-1 source without promoting or deleting
 * either authority path. A next file is always late drift once migration
 * state exists, even when its bytes are otherwise valid.
 */
export async function readGenerationSettingsV1SourceSnapshot(
  dataDir: string
): Promise<GenerationSettingsV1Source> {
  const finalFile = path.join(dataDir, SETTINGS_STATE_V1_FILE);
  const nextFile = path.join(dataDir, SETTINGS_STATE_V1_NEXT_FILE);
  try {
    const [finalBytes, nextBytes] = await Promise.all([
      readOptionalV1Snapshot(finalFile),
      readOptionalV1Snapshot(nextFile)
    ]);
    if (nextBytes !== null) throw sourceChanged();
    if (finalBytes !== null) {
      return source(parseGenerationSettingsV1Bytes(finalBytes), "file");
    }
    return Object.freeze({
      settings: ABSENT_SETTINGS_V1,
      sourceTag: "absent-default",
      canonicalV1Hash: ABSENT_SETTINGS_V1_HASH
    });
  } catch (error) {
    if (error instanceof ServiceError && error.code === "idempotency_conflict") {
      throw error;
    }
    throw sourceChanged(error);
  }
}

function source(
  settings: GenerationSettings,
  sourceTag: "file"
): GenerationSettingsV1Source {
  return Object.freeze({
    settings,
    sourceTag,
    canonicalV1Hash: hashCanonicalGenerationSettingsV1(settings)
  });
}

async function readOptionalV1Snapshot(file: string): Promise<Buffer | null> {
  try {
    return await readBoundedRegularFile(file, MAX_SETTINGS_DOCUMENT_BYTES, {
      allowLegacyOwnerReadMode: true
    });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function sourceChanged(cause?: unknown): ServiceError {
  const error = new ServiceError(
    409,
    "Settings format migration source changed before activation.",
    "idempotency_conflict"
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
