import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  inspectPrivateDirectory,
  publishPrivateFileNoReplace,
  readOptionalPrivateFile,
  removePrivateFile,
  syncPrivateDirectory
} from "../../server/private-file-publication.js";
import { withPrivateFileLock } from "../../server/private-file-lock.js";
import {
  createDurableMutationId,
  isDurableMutationId
} from "../../shared/durable-mutation-id.js";
import { isHttpDataDirectoryId } from "../../shared/http-data-directory-id.js";
import { isCanonicalLoopbackOrigin } from "../../shared/http-loopback-origin.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";
import {
  hasRetainedPrivateFileClaims,
  retainPrivateFileClaim,
  type PrivateFileClaim
} from "../../server/private-file-claim.js";
import {
  mutationClaimCohortFile,
  mutationClaimCohortIsConfirmed,
  readMutationClaimCohort,
  registerMutationClaim,
  removeMutationClaimCohort,
  settleMutationClaim,
  type HttpMutationClaimOutcome
} from "./http-mutation-claim-cohort.js";

const INTENT_DIRECTORY = "http-mutation-intents";
const INTENT_LOCK_FILE = "http-mutation-intents.lock";
const HASH = /^[0-9a-f]{64}$/;
const MAX_INTENT_BYTES = 1_024;
const INTENT_LOCK_TIMEOUT_MS = 5_000;
const POLICY = {
  label: "1667 HTTP mutation intent",
  maxBytes: MAX_INTENT_BYTES
} as const;

export type HttpAbsentMutation = "createStory" | "importSillyTavern" | "importMarkdown" | "importNovelAI";

export interface HttpMutationIntentClaim {
  readonly mutationId: string;
  /** True when this claim reuses a previously published mutation identity. */
  readonly reused: boolean;
  complete(): Promise<void>;
  retain(): Promise<void>;
}

export interface HttpMutationIntentStore {
  claim(
    operation: HttpAbsentMutation,
    semanticInput: string
  ): Promise<HttpMutationIntentClaim>;
}

export {
  MemoryHttpMutationIntentStore
} from "./http-memory-mutation-intents.js";

interface HttpMutationIntentRecord {
  readonly format: "1667-http-mutation-intent";
  readonly schemaVersion: 2;
  readonly dataDirectoryClaimId: string;
  readonly dataDirectoryId: string;
  readonly operation: HttpAbsentMutation;
  readonly fingerprint: string;
  readonly mutationId: string;
  readonly createdAt: string;
}

interface LegacyHttpMutationIntentRecord {
  readonly format: "1667-http-mutation-intent";
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly operation: HttpAbsentMutation;
  readonly fingerprint: string;
  readonly mutationId: string;
  readonly createdAt: string;
}

export interface PrivateHttpMutationIntentStoreOptions {
  readonly dataDirectoryId: string;
  readonly dataDirectoryClaimId: string;
  readonly origin: string;
  readonly privateStateRoot: string;
}

/**
 * Keeps only the durable identity and input fingerprint. User content remains
 * with the caller, while an exact retry after process/listener replacement can
 * still reach the authoritative server receipt.
 */
export class PrivateHttpMutationIntentStore
implements HttpMutationIntentStore {
  private constructor(
    private readonly dataDirectoryId: string,
    private readonly dataDirectoryClaimId: string,
    private readonly origin: string,
    private readonly directory: string
  ) {}

  static async create(
    options: PrivateHttpMutationIntentStoreOptions
  ): Promise<PrivateHttpMutationIntentStore> {
    if (!isHttpDataDirectoryId(options.dataDirectoryId)
      || !isHttpDataDirectoryId(options.dataDirectoryClaimId)) {
      throw new Error("1667 HTTP mutation intent data directory ID is invalid");
    }
    if (!isCanonicalLoopbackOrigin(options.origin)) {
      throw new Error("1667 HTTP mutation intent listener origin is invalid");
    }
    await inspectPrivateDirectory(
      options.privateStateRoot,
      "1667 private state root"
    );
    const directory = path.join(options.privateStateRoot, INTENT_DIRECTORY);
    try {
      await mkdir(directory, { mode: 0o700 });
      await syncPrivateDirectory(
        options.privateStateRoot,
        "1667 private state root"
      );
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    await inspectPrivateDirectory(directory, POLICY.label);
    return new PrivateHttpMutationIntentStore(
      options.dataDirectoryId,
      options.dataDirectoryClaimId,
      options.origin,
      directory
    );
  }

  async claim(
    operation: HttpAbsentMutation,
    semanticInput: string
  ): Promise<HttpMutationIntentClaim> {
    const fingerprint = mutationFingerprint(
      this.dataDirectoryId,
      operation,
      semanticInput
    );
    const file = path.join(this.directory, `${fingerprint}.json`);
    const legacyFingerprint = legacyMutationFingerprint(
      operation,
      semanticInput
    );
    const legacyFile = path.join(
      this.directory,
      `${legacyFingerprint}.json`
    );
    return await this.withIntentLock(async () => {
      let [legacyRecord, currentRecord] = await Promise.all([
        this.readLegacyIntent(legacyFile, operation, legacyFingerprint),
        this.read(file, operation, fingerprint)
      ]);
      if (legacyRecord !== null) {
        legacyRecord = await this.recoverSettledIntent(
          legacyFile,
          legacyRecord,
          async () => await this.readLegacyIntent(
            legacyFile,
            operation,
            legacyFingerprint
          )
        );
      }
      if (currentRecord !== null) {
        currentRecord = await this.recoverSettledIntent(
          file,
          currentRecord,
          async () => await this.read(file, operation, fingerprint)
        );
      }
      if (legacyRecord !== null && currentRecord !== null) {
        throw new Error(
          "Pending HTTP mutation intents contain ambiguous versions"
        );
      }
      if (legacyRecord !== null) {
        return await this.retainIntentClaim(
          legacyFile,
          legacyRecord,
          true,
          async () => await this.readLegacyIntent(
            legacyFile,
            operation,
            legacyFingerprint
          )
        );
      }
      let record = currentRecord;
      const reused = record !== null;
      if (record === null) {
        const candidate: HttpMutationIntentRecord = {
          format: "1667-http-mutation-intent",
          schemaVersion: 2,
          dataDirectoryClaimId: this.dataDirectoryClaimId,
          dataDirectoryId: this.dataDirectoryId,
          operation,
          fingerprint,
          mutationId: createDurableMutationId(),
          createdAt: new Date().toISOString()
        };
        await publishPrivateFileNoReplace(
          file,
          encodeIntent(candidate),
          POLICY
        );
        record = candidate;
      }
      return await this.retainIntentClaim(
        file,
        record,
        reused,
        async () => await this.read(file, operation, fingerprint)
      );
    });
  }

  private async readLegacyIntent(
    file: string,
    operation: HttpAbsentMutation,
    fingerprint: string
  ): Promise<LegacyHttpMutationIntentRecord | null> {
    const bytes = await readOptionalPrivateFile(file, POLICY);
    if (bytes === null) return null;
    const record = decodeLegacyIntent(bytes, operation, fingerprint);
    if (record.origin !== this.origin) {
      throw new Error(
        "Pending HTTP mutation intent belongs to a different listener origin"
      );
    }
    return record;
  }

  private async recoverSettledIntent<T extends { readonly mutationId: string }>(
    file: string,
    record: T,
    readRecord: () => Promise<T | null>
  ): Promise<T | null> {
    const cohortFile = mutationClaimCohortFile(file);
    const cohort = await readMutationClaimCohort(
      cohortFile,
      record.mutationId
    );
    if (cohort === null
      || await hasRetainedPrivateFileClaims(file, POLICY)) {
      return record;
    }
    await removeMutationClaimCohort(cohortFile);
    if (!mutationClaimCohortIsConfirmed(cohort)) return record;
    const current = await readRecord();
    if (current === null || current.mutationId !== record.mutationId) {
      throw new Error("1667 HTTP mutation intent identity changed");
    }
    await removePrivateFile(file, POLICY);
    return null;
  }

  private async retainIntentClaim<T extends { readonly mutationId: string }>(
    file: string,
    record: T,
    reused: boolean,
    readRecord: () => Promise<T | null>
  ): Promise<HttpMutationIntentClaim> {
    const cohortFile = mutationClaimCohortFile(file);
    const cohort = await readMutationClaimCohort(
      cohortFile,
      record.mutationId
    );
    const unknownActiveClaim = cohort === null
      && await hasRetainedPrivateFileClaims(file, POLICY);
    const retained = await retainPrivateFileClaim(file, POLICY);
    let registration;
    try {
      registration = await registerMutationClaim(
        cohortFile,
        record.mutationId,
        cohort,
        unknownActiveClaim
      );
    } catch (error) {
      await retained.release().catch(() => undefined);
      throw error;
    }
    let settlement: Promise<void> | null = null;
    const settle = (
      outcome: Exclude<HttpMutationClaimOutcome, "active">
    ): Promise<void> => settlement ??= this.settleIntentClaim({
      file,
      cohortFile,
      mutationId: record.mutationId,
      claimId: registration.claimId,
      outcome,
      retained,
      readRecord
    });
    return {
      mutationId: record.mutationId,
      reused,
      complete: async () => await settle("confirmed"),
      retain: async () => await settle("uncertain")
    };
  }

  private async settleIntentClaim<T extends { readonly mutationId: string }>(
    input: {
      readonly file: string;
      readonly cohortFile: string;
      readonly mutationId: string;
      readonly claimId: string;
      readonly outcome: Exclude<HttpMutationClaimOutcome, "active">;
      readonly retained: PrivateFileClaim;
      readonly readRecord: () => Promise<T | null>;
    }
  ): Promise<void> {
    try {
      await this.withIntentLock(async () => {
        const current = await input.readRecord();
        if (current === null || current.mutationId !== input.mutationId) {
          throw new Error("1667 HTTP mutation intent identity changed");
        }
        const cohort = await readMutationClaimCohort(
          input.cohortFile,
          input.mutationId
        );
        if (cohort === null) return;
        const settled = await settleMutationClaim(
          input.cohortFile,
          cohort,
          input.claimId,
          input.outcome
        );
        if (settled === null) return;
        await input.retained.release();
        if (await hasRetainedPrivateFileClaims(input.file, POLICY)) return;
        await removeMutationClaimCohort(input.cohortFile);
        if (mutationClaimCohortIsConfirmed(settled)) {
          await removePrivateFile(input.file, POLICY);
        }
      });
    } finally {
      await input.retained.release().catch(() => undefined);
    }
  }

  private async withIntentLock<T>(
    work: () => Promise<T>
  ): Promise<T> {
    return await withPrivateFileLock({
      directory: this.directory,
      fileName: INTENT_LOCK_FILE,
      directoryLabel: POLICY.label,
      timeoutMs: INTENT_LOCK_TIMEOUT_MS,
      contentionMessage: (lockPath) =>
        `1667 HTTP mutation intent is locked by another process: ${lockPath}`
    }, work);
  }

  private async read(
    file: string,
    operation: HttpAbsentMutation,
    fingerprint: string
  ): Promise<HttpMutationIntentRecord | null> {
    const bytes = await readOptionalPrivateFile(file, POLICY);
    if (bytes === null) return null;
    return decodeIntent(
      bytes,
      this.dataDirectoryId,
      this.dataDirectoryClaimId,
      operation,
      fingerprint
    );
  }
}

function mutationFingerprint(
  dataDirectoryId: string,
  operation: HttpAbsentMutation,
  semanticInput: string
): string {
  return createHash("sha256")
    .update("1667-http-absent-mutation-v2", "utf8")
    .update("\0", "utf8")
    .update(dataDirectoryId, "utf8")
    .update("\0", "utf8")
    .update(operation, "utf8")
    .update("\0", "utf8")
    .update(semanticInput, "utf8")
    .digest("hex");
}

function legacyMutationFingerprint(
  operation: HttpAbsentMutation,
  semanticInput: string
): string {
  return createHash("sha256")
    .update("1667-http-absent-mutation-v1", "utf8")
    .update("\0", "utf8")
    .update(operation, "utf8")
    .update("\0", "utf8")
    .update(semanticInput, "utf8")
    .digest("hex");
}

function decodeIntent(
  bytes: Uint8Array,
  dataDirectoryId: string,
  dataDirectoryClaimId: string,
  operation: HttpAbsentMutation,
  fingerprint: string
): HttpMutationIntentRecord {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseJsonRejectingDuplicateKeys(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw corruptIntent();
  }
  const record = value as Partial<HttpMutationIntentRecord>;
  if (Object.keys(record).join(",")
      !== "format,schemaVersion,dataDirectoryClaimId,dataDirectoryId,operation,fingerprint,mutationId,createdAt"
    || record.format !== "1667-http-mutation-intent"
    || record.schemaVersion !== 2
    || record.dataDirectoryId !== dataDirectoryId
    || record.operation !== operation
    || record.fingerprint !== fingerprint
    || !HASH.test(record.fingerprint)
    || typeof record.mutationId !== "string"
    || !isDurableMutationId(record.mutationId)
    || typeof record.createdAt !== "string"
    || canonicalTime(record.createdAt) !== record.createdAt) {
    throw corruptIntent();
  }
  if (record.dataDirectoryClaimId !== dataDirectoryClaimId
    || !isHttpDataDirectoryId(record.dataDirectoryClaimId)) {
    throw new Error(
      "Pending HTTP mutation intent belongs to a different data-directory claim"
    );
  }
  return record as HttpMutationIntentRecord;
}

function decodeLegacyIntent(
  bytes: Uint8Array,
  operation: HttpAbsentMutation,
  fingerprint: string
): LegacyHttpMutationIntentRecord {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseJsonRejectingDuplicateKeys(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw corruptIntent();
  }
  const record = value as Partial<LegacyHttpMutationIntentRecord>;
  if (Object.keys(record).join(",")
      !== "format,schemaVersion,origin,operation,fingerprint,mutationId,createdAt"
    || record.format !== "1667-http-mutation-intent"
    || record.schemaVersion !== 1
    || typeof record.origin !== "string"
    || !isCanonicalLoopbackOrigin(record.origin)
    || record.operation !== operation
    || record.fingerprint !== fingerprint
    || !HASH.test(record.fingerprint)
    || typeof record.mutationId !== "string"
    || !isDurableMutationId(record.mutationId)
    || typeof record.createdAt !== "string"
    || canonicalTime(record.createdAt) !== record.createdAt) {
    throw corruptIntent();
  }
  return record as LegacyHttpMutationIntentRecord;
}

function encodeIntent(record: HttpMutationIntentRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function canonicalTime(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function corruptIntent(): Error {
  return new Error("1667 HTTP mutation intent is malformed");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
