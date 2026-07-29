import { isSemVer } from "../shared/semver.js";

const COMMIT = /^[0-9a-f]{40}$/u;
const RUN_NUMBER = /^[1-9]\d{0,15}$/u;
const MAX_VERSION_BYTES = 128;

export type NpmOperationIdentityOperation = "promotion" | "quarantine";

export interface NpmOperationIdentity {
  readonly runId: string;
  readonly runAttempt: string;
  readonly operation: NpmOperationIdentityOperation;
  readonly version: string;
  readonly sourceCommit: string;
}

export function requireNpmOperationIdentity(
  value: NpmOperationIdentity
): NpmOperationIdentity {
  return Object.freeze({
    runId: requireNpmOperationRunNumber(value.runId),
    runAttempt: requireNpmOperationRunNumber(value.runAttempt),
    operation: requireNpmOperationIdentityOperation(value.operation),
    version: requireNpmOperationVersion(value.version),
    sourceCommit: requireNpmOperationSourceCommit(value.sourceCommit)
  });
}

export function requireNpmOperationRunNumber(value: unknown): string {
  if (typeof value !== "string"
    || !RUN_NUMBER.test(value)
    || !Number.isSafeInteger(Number(value))) {
    throw new Error("npm operation run number is invalid");
  }
  return value;
}

export function requireNpmOperationIdentityOperation(
  value: unknown
): NpmOperationIdentityOperation {
  if (value !== "promotion" && value !== "quarantine") {
    throw new Error("npm operation kind is invalid");
  }
  return value;
}

export function requireNpmOperationVersion(value: unknown): string {
  if (typeof value !== "string"
    || Buffer.byteLength(value) > MAX_VERSION_BYTES
    || !isSemVer(value)) {
    throw new Error("npm operation version is invalid");
  }
  return value;
}

export function requireNpmOperationSourceCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error("npm operation source commit is invalid");
  }
  return value;
}
