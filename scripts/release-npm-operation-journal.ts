import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  realpathSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { canonicalJson } from "../server/canonical-json.js";
import {
  NPM_OPERATION_JOURNAL_MAX_BYTES,
  NPM_OPERATION_JOURNAL_MAX_RECORDS
} from "./release-npm-operation-journal-limits.js";
import { NPM_PUBLIC_REGISTRY } from "./release-npm-public-client.js";
import {
  type NpmPackageTagState,
  type NpmReleaseOperation,
  type NpmReleaseOperationParameters,
  type NpmTagOperationEvent,
  type NpmTagOperationEvidence
} from "./release-npm-operations.js";

export interface NpmTagObservationError {
  readonly name: string;
  readonly message: string;
}

export interface NpmTagOperationJournalIdentity {
  readonly runId: string;
  readonly runAttempt: string;
  readonly operation: NpmReleaseOperation;
  readonly version: string;
  readonly sourceCommit: string;
  readonly parameters: NpmReleaseOperationParameters;
}

export interface NpmTagOperationJournalOptions {
  readonly maxBytes?: number;
  readonly maxRecords?: number;
}

export class NpmTagOperationJournal {
  #bytes = 0;
  #records = 0;
  readonly #descriptor: number;
  readonly #identity: NpmTagOperationJournalIdentity;
  readonly #maxBytes: number;
  readonly #maxRecords: number;
  readonly #packageOrder: readonly string[];

  constructor(
    evidencePath: string,
    identity: NpmTagOperationJournalIdentity,
    packageOrder: readonly string[],
    options: NpmTagOperationJournalOptions = {}
  ) {
    const maxBytes = boundedLimit(
      options.maxBytes,
      NPM_OPERATION_JOURNAL_MAX_BYTES,
      "byte"
    );
    const maxRecords = boundedLimit(
      options.maxRecords,
      NPM_OPERATION_JOURNAL_MAX_RECORDS,
      "record"
    );
    const reservation = reserveEvidenceFile(evidencePath);
    this.#descriptor = reservation.descriptor;
    this.#identity = Object.freeze({ ...identity });
    this.#maxBytes = maxBytes;
    this.#maxRecords = maxRecords;
    this.#packageOrder = packageOrder;
    try {
      this.#append({
        schemaVersion: 1,
        record: "started",
        ...this.#identity,
        registry: NPM_PUBLIC_REGISTRY,
        packageOrder
      });
      syncDirectory(reservation.parent);
    } catch (error) {
      closeSync(this.#descriptor);
      throw error;
    }
  }

  readonly record = (event: NpmTagOperationEvent): void => {
    this.#append({
      schemaVersion: 1,
      record: "event",
      ...this.#identity,
      event
    });
  };

  complete(result: NpmTagOperationEvidence): void {
    this.#append({
      schemaVersion: 1,
      record: "complete",
      ...this.#identity,
      result
    });
  }

  fail(
    message: string,
    observed: readonly NpmPackageTagState[],
    observationErrors: readonly NpmTagObservationError[]
  ): void {
    this.#append({
      schemaVersion: 1,
      record: "failed",
      ...this.#identity,
      failure: { message, observed, observationErrors }
    });
  }

  close(): void {
    closeSync(this.#descriptor);
  }

  #append(record: unknown): void {
    const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (this.#records >= this.#maxRecords) {
      throw new Error("npm operation journal exceeds the recovery record bound");
    }
    if (bytes.length > this.#maxBytes - this.#bytes) {
      throw new Error("npm operation journal exceeds the recovery byte bound");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(
        this.#descriptor,
        bytes,
        offset,
        bytes.length - offset
      );
      if (written <= 0) throw new Error("npm operation journal write did not progress");
      offset += written;
    }
    this.#bytes += bytes.length;
    this.#records += 1;
    fsyncSync(this.#descriptor);
  }
}

function boundedLimit(
  requested: number | undefined,
  maximum: number,
  name: string
): number {
  const value = requested ?? maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`npm operation journal ${name} bound is invalid`);
  }
  return value;
}

function reserveEvidenceFile(
  value: string
): { readonly descriptor: number; readonly parent: string } {
  if (!path.isAbsolute(value)) {
    throw new Error("npm tag operation evidence path must be absolute");
  }
  const parent = realpathSync(path.dirname(value));
  const canonical = path.join(parent, path.basename(value));
  if (canonical !== value) {
    throw new Error("npm tag operation evidence path must be canonical");
  }
  return Object.freeze({
    descriptor: openSync(
      canonical,
      constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
        | constants.O_NOFOLLOW,
      0o600
    ),
    parent
  });
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const directoryDescriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY
  );
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}
