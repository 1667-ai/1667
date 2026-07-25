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
import { createDurableMutationId } from "../../shared/durable-mutation-id.js";
import { parseJsonRejectingDuplicateKeys } from "../../shared/strict-json.js";

const INTENT_DIRECTORY = "http-mutation-intents";
const MUTATION_ID = /^m1\.[0-9]{13}\.[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_INTENT_BYTES = 1_024;
const POLICY = {
  label: "1667 HTTP mutation intent",
  maxBytes: MAX_INTENT_BYTES
} as const;

export type HttpAbsentMutation = "createStory" | "importSillyTavern";

export interface HttpMutationIntentClaim {
  readonly mutationId: string;
  complete(): Promise<void>;
}

export interface HttpMutationIntentStore {
  claim(
    operation: HttpAbsentMutation,
    semanticInput: string
  ): Promise<HttpMutationIntentClaim>;
}

interface HttpMutationIntentRecord {
  readonly format: "1667-http-mutation-intent";
  readonly schemaVersion: 1;
  readonly origin: string;
  readonly operation: HttpAbsentMutation;
  readonly fingerprint: string;
  readonly mutationId: string;
  readonly createdAt: string;
}

/**
 * Keeps only the durable identity and input fingerprint. User content remains
 * with the caller, while an exact retry after process/listener replacement can
 * still reach the authoritative server receipt.
 */
export class PrivateHttpMutationIntentStore
implements HttpMutationIntentStore {
  private constructor(
    private readonly origin: string,
    private readonly directory: string
  ) {}

  static async create(
    origin: string,
    privateStateRoot: string
  ): Promise<PrivateHttpMutationIntentStore> {
    await inspectPrivateDirectory(privateStateRoot, "1667 private state root");
    const directory = path.join(privateStateRoot, INTENT_DIRECTORY);
    try {
      await mkdir(directory, { mode: 0o700 });
      await syncPrivateDirectory(
        privateStateRoot,
        "1667 private state root"
      );
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    await inspectPrivateDirectory(directory, POLICY.label);
    return new PrivateHttpMutationIntentStore(origin, directory);
  }

  async claim(
    operation: HttpAbsentMutation,
    semanticInput: string
  ): Promise<HttpMutationIntentClaim> {
    const fingerprint = mutationFingerprint(operation, semanticInput);
    const file = path.join(this.directory, `${fingerprint}.json`);
    let record = await this.read(file, operation, fingerprint);
    if (record === null) {
      const candidate: HttpMutationIntentRecord = {
        format: "1667-http-mutation-intent",
        schemaVersion: 1,
        origin: this.origin,
        operation,
        fingerprint,
        mutationId: createDurableMutationId(),
        createdAt: new Date().toISOString()
      };
      try {
        await publishPrivateFileNoReplace(
          file,
          Buffer.from(`${JSON.stringify(candidate)}\n`, "utf8"),
          POLICY
        );
        record = candidate;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
        record = await this.read(file, operation, fingerprint);
        if (record === null) {
          throw new Error("1667 HTTP mutation intent disappeared during claim");
        }
      }
    }
    const claimedMutationId = record.mutationId;
    return {
      mutationId: claimedMutationId,
      complete: async () => {
        const current = await this.read(file, operation, fingerprint);
        if (current === null) return;
        if (current.mutationId !== claimedMutationId) {
          throw new Error("1667 HTTP mutation intent identity changed");
        }
        await removePrivateFile(file, POLICY);
      }
    };
  }

  private async read(
    file: string,
    operation: HttpAbsentMutation,
    fingerprint: string
  ): Promise<HttpMutationIntentRecord | null> {
    const bytes = await readOptionalPrivateFile(file, POLICY);
    if (bytes === null) return null;
    return decodeIntent(bytes, this.origin, operation, fingerprint);
  }
}

export class MemoryHttpMutationIntentStore
implements HttpMutationIntentStore {
  private readonly records = new Map<string, string>();

  async claim(
    operation: HttpAbsentMutation,
    semanticInput: string
  ): Promise<HttpMutationIntentClaim> {
    const fingerprint = mutationFingerprint(operation, semanticInput);
    const mutationId = this.records.get(fingerprint)
      ?? createDurableMutationId();
    this.records.set(fingerprint, mutationId);
    return {
      mutationId,
      complete: async () => {
        if (this.records.get(fingerprint) === mutationId) {
          this.records.delete(fingerprint);
        }
      }
    };
  }
}

function mutationFingerprint(
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
  origin: string,
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
      !== "format,schemaVersion,origin,operation,fingerprint,mutationId,createdAt"
    || record.format !== "1667-http-mutation-intent"
    || record.schemaVersion !== 1
    || record.origin !== origin
    || record.operation !== operation
    || record.fingerprint !== fingerprint
    || !HASH.test(record.fingerprint)
    || typeof record.mutationId !== "string"
    || !MUTATION_ID.test(record.mutationId)
    || typeof record.createdAt !== "string"
    || canonicalTime(record.createdAt) !== record.createdAt) {
    throw corruptIntent();
  }
  return record as HttpMutationIntentRecord;
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
