import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  NPM_OPERATION_JOURNAL_MAX_BYTES,
  NPM_OPERATION_JOURNAL_MAX_RECORDS
} from "./release-npm-operation-journal-limits.js";
import { NPM_PUBLIC_REGISTRY } from "./release-npm-public-client.js";
import {
  requireNpmOperationIdentity,
  type NpmOperationIdentity
} from "./release-npm-operation-identity.js";
import {
  npmQuarantineMessage,
  npmReleaseOperationPackageOrder,
  validateNpmPromotionRequest,
  validateNpmQuarantineRequest,
  type NpmPackageTagState,
  type NpmPromotionRequest,
  type NpmQuarantineRequest,
  type NpmReleaseOperationParameters,
  type NpmTagWrite
} from "./release-npm-operations.js";

export type NpmOperationReconciliationIdentity = NpmOperationIdentity;
export interface NpmOperationJournalRead {
  readonly parameters: NpmReleaseOperationParameters;
  readonly packageOrder: readonly string[]; readonly records: number;
  readonly sha256: string;
  readonly terminal: "complete" | "failed" | null;
  readonly writeAttempts: number;
}

export function readNpmOperationJournal(
  journalPath: string,
  expected: NpmOperationReconciliationIdentity
): NpmOperationJournalRead {
  validateIdentity(expected);
  const file = boundedJournal(journalPath);
  const bytes = readFileSync(file);
  if (bytes.at(-1) !== 0x0a) throw new Error("npm operation journal has a truncated final record");
  const text = decodeUtf8(bytes);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > NPM_OPERATION_JOURNAL_MAX_RECORDS
    || lines.some((line) => line === "" || line.endsWith("\r"))) {
    throw new Error("npm operation journal has an invalid record boundary");
  }

  const seenLines = new Set<string>();
  let parameters: NpmReleaseOperationParameters | undefined;
  const order = npmReleaseOperationPackageOrder(expected.operation);
  let before: readonly NpmPackageTagState[] | null = null;
  let after: readonly NpmPackageTagState[] | null = null;
  let pendingWrite: NpmTagWrite | null = null;
  let terminal: "complete" | "failed" | null = null;
  let writeAttempts = 0;
  let quarantineDeprecationPhase = false;
  let lastWriteIndex = -1;
  const writeKeys = new Set<string>();

  for (const [index, line] of lines.entries()) {
    if (seenLines.has(line)) throw new Error("npm operation journal repeats a record");
    seenLines.add(line);
    const parsed = parseJsonRejectingDuplicateKeys(line);
    if (canonicalJson(parsed) !== line) {
      throw new Error("npm operation journal record is not canonical JSON");
    }
    const record = exactRecord(
      parsed, recordKeys(parsed), "npm operation journal record"
    );
    validateRecordIdentity(record, expected);
    const recordParameters = parseParameters(record.parameters, expected.version);
    if (recordParameters.operation !== expected.operation) {
      throw new Error("npm operation journal parameters name the wrong operation");
    }
    if (parameters === undefined) parameters = recordParameters;
    else if (canonicalJson(parameters) !== canonicalJson(recordParameters)) {
      throw new Error("npm operation journal changes operation parameters");
    }
    if (terminal !== null) {
      throw new Error("npm operation journal has a record after its terminal record");
    }
    if (index === 0) {
      if (record.record !== "started" || record.registry !== NPM_PUBLIC_REGISTRY
        || !sameStrings(record.packageOrder, order)) {
        throw new Error("npm operation journal has an invalid started record");
      }
      continue;
    }
    if (record.record === "started") {
      throw new Error("npm operation journal repeats its started record");
    }
    if (record.record === "event") {
      const event = exactRecord(record.event, eventKeys(record.event), "npm operation event");
      if (event.kind === "before") {
        if (before !== null || after !== null || pendingWrite !== null || writeAttempts !== 0) {
          throw new Error("npm operation journal has an out-of-order before event");
        }
        before = validateStates(event.states, expected.version, order);
      } else if (event.kind === "write-attempt") {
        if (before === null || after !== null || pendingWrite !== null) {
          throw new Error("npm operation journal has an out-of-order write attempt");
        }
        const write = validateWrite(event.write, expected.version, parameters);
        const writeIndex = order.indexOf(write.name);
        if (expected.operation === "quarantine") {
          const deprecation = write.kind === "deprecate";
          if (quarantineDeprecationPhase && !deprecation) {
            throw new Error("npm operation journal removes a tag after deprecation starts");
          }
          if (deprecation !== quarantineDeprecationPhase) {
            quarantineDeprecationPhase = deprecation;
            lastWriteIndex = -1;
          }
        }
        if (writeIndex < lastWriteIndex) {
          throw new Error("npm operation journal changes packages out of order");
        }
        lastWriteIndex = writeIndex;
        const writeKey = canonicalJson(write);
        if (writeKeys.has(writeKey)) throw new Error("npm operation journal repeats a write");
        writeKeys.add(writeKey);
        pendingWrite = write;
        writeAttempts += 1;
      } else if (event.kind === "write-verified") {
        const write = validateWrite(event.write, expected.version, parameters);
        if (pendingWrite === null
          || canonicalJson(write) !== canonicalJson(pendingWrite)) {
          throw new Error("npm operation journal verifies the wrong write");
        }
        const state = validateNpmPackageTagState(
          event.state, expected.version, order
        );
        if (state.name !== write.name) {
          throw new Error("npm operation journal verifies a write with the wrong package");
        }
        pendingWrite = null;
      } else if (event.kind === "after") {
        if (before === null || after !== null || pendingWrite !== null) {
          throw new Error("npm operation journal has an out-of-order after event");
        }
        after = validateStates(event.states, expected.version, order);
      }
      continue;
    }
    if (record.record === "complete") {
      if (before === null || after === null || pendingWrite !== null) {
        throw new Error("npm operation journal completes before its after observation");
      }
      validateResult(record.result, expected, parameters, order, before, after);
      terminal = "complete";
    } else if (record.record === "failed") {
      validateFailure(record.failure, expected.version, order);
      terminal = "failed";
    }
  }
  if (parameters === undefined) throw new Error("npm operation journal has no started record");
  return Object.freeze({
    parameters,
    packageOrder: order,
    records: lines.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    terminal,
    writeAttempts
  });
}

function validateResult(
  value: unknown,
  identity: NpmOperationReconciliationIdentity,
  parameters: NpmReleaseOperationParameters,
  order: readonly string[],
  before: readonly NpmPackageTagState[],
  after: readonly NpmPackageTagState[]
): void {
  const result = exactRecord(value, new Set([
    "schemaVersion", "operation", "registry", "version", "parameters",
    "packageOrder", "before", "after"
  ]), "npm operation result");
  if (result.schemaVersion !== 1 || result.operation !== identity.operation
    || result.registry !== NPM_PUBLIC_REGISTRY || result.version !== identity.version
    || canonicalJson(parseParameters(result.parameters, identity.version))
      !== canonicalJson(parameters)
    || !sameStrings(result.packageOrder, order)
    || canonicalJson(validateStates(result.before, identity.version, order))
      !== canonicalJson(before)
    || canonicalJson(validateStates(result.after, identity.version, order))
      !== canonicalJson(after)) {
    throw new Error("npm operation journal has an invalid complete result");
  }
}

function validateFailure(
  value: unknown, version: string, order: readonly string[]
): void {
  const failure = exactRecord(value, new Set([
    "message", "observed", "observationErrors"
  ]), "npm operation failure");
  nonemptyString(failure.message, "npm operation failure message");
  if (!Array.isArray(failure.observed) || !Array.isArray(failure.observationErrors)) {
    throw new Error("npm operation failure observations are invalid");
  }
  const observedNames: string[] = failure.observed.map((state) => {
    return validateNpmPackageTagState(state, version, order).name;
  });
  const errorNames: string[] = [];
  for (const value of failure.observationErrors) {
    const error = exactRecord(
      value,
      new Set(["name", "message"]),
      "npm operation observation error"
    );
    errorNames.push(canonicalName(error.name, order));
    nonemptyString(error.message, "npm operation observation error message");
  }
  for (const names of [observedNames, errorNames]) {
    if (names.some((name, index) => index > 0
      && order.indexOf(name) <= order.indexOf(names[index - 1]!))) {
      throw new Error("npm operation failure observations are out of order");
    }
  }
  const names = [...observedNames, ...errorNames];
  if (new Set(names).size !== order.length
    || order.some((name) => !names.includes(name))) {
    throw new Error("npm operation failure does not account for every package");
  }
}

function validateStates(
  value: unknown,
  version: string,
  order: readonly string[]
): readonly NpmPackageTagState[] {
  if (!Array.isArray(value) || value.length !== order.length) {
    throw new Error("npm operation journal has an incomplete package state set");
  }
  const states = value.map((state) => {
    return validateNpmPackageTagState(state, version, order);
  });
  if (states.some((state, index) => state.name !== order[index])) {
    throw new Error("npm operation journal package states are out of order");
  }
  return Object.freeze(states);
}
export function validateNpmPackageTagState(
  value: unknown,
  version: string,
  order: readonly string[]
): NpmPackageTagState {
  const state = exactRecord(value, new Set([
    "name", "version", "present", "deprecated", "tags"
  ]), "npm package tag state");
  const name = canonicalName(state.name, order);
  if (state.version !== version || typeof state.present !== "boolean"
    || (state.deprecated !== null && typeof state.deprecated !== "string")
    || (!state.present && state.deprecated !== null)) {
    throw new Error("npm operation journal has an invalid package state");
  }
  const tagsRecord = object(state.tags, "npm package tag state tags");
  const tags = Object.create(null) as Record<string, string>;
  for (const [tag, taggedVersion] of Object.entries(tagsRecord)) {
    if (tag === "" || typeof taggedVersion !== "string" || taggedVersion === "") {
      throw new Error("npm operation journal has invalid dist-tag state");
    }
    tags[tag] = taggedVersion;
  }
  return Object.freeze({
    name,
    version,
    present: state.present,
    deprecated: state.deprecated as string | null,
    tags: Object.freeze(tags)
  });
}
function validateWrite(
  value: unknown, version: string, parameters: NpmReleaseOperationParameters
): NpmTagWrite {
  const input = object(value, "npm tag write");
  const keys = input.kind === "deprecate"
    ? new Set(["kind", "name", "version", "message"])
    : new Set(["kind", "name", "version", "tag"]);
  const write = exactRecord(input, keys, "npm tag write");
  const order = npmReleaseOperationPackageOrder(parameters.operation);
  const name = canonicalName(write.name, order);
  if (write.version !== version) throw new Error("npm tag write has the wrong version");
  if (parameters.operation === "promotion") {
    if (write.kind !== "add" || typeof write.tag !== "string"
      || write.tag !== parameters.promotion.destination) {
      throw new Error("npm promotion journal has an invalid tag write");
    }
    return Object.freeze({ kind: "add", name, version, tag: write.tag });
  }
  if (write.kind === "remove") {
    nonemptyString(write.tag, "npm quarantine tag");
    return Object.freeze({ kind: "remove", name, version, tag: write.tag as string });
  }
  const message = npmQuarantineMessage(parameters.quarantine);
  if (write.kind !== "deprecate" || write.message !== message) {
    throw new Error("npm quarantine journal has an invalid deprecation write");
  }
  return Object.freeze({ kind: "deprecate", name, version, message });
}
function parseParameters(value: unknown, version: string): NpmReleaseOperationParameters {
  const input = object(value, "npm operation parameters");
  if (input.operation === "promotion") {
    const outer = exactRecord(
      input,
      new Set(["operation", "promotion"]),
      "npm promotion parameters"
    );
    const promotion = exactRecord(
      outer.promotion,
      new Set(["destination", "stableAcknowledged"]),
      "npm promotion request"
    ) as unknown as NpmPromotionRequest;
    return Object.freeze({
      operation: "promotion" as const,
      promotion: validateNpmPromotionRequest(promotion)
    });
  }
  const outer = exactRecord(
    input,
    new Set(["operation", "quarantine"]),
    "npm quarantine parameters"
  );
  const quarantine = exactRecord(
    outer.quarantine,
    new Set(["incidentReference", "supersedingVersion"]),
    "npm quarantine request"
  ) as unknown as NpmQuarantineRequest;
  return Object.freeze({
    operation: "quarantine" as const,
    quarantine: validateNpmQuarantineRequest(version, quarantine)
  });
}
function validateRecordIdentity(
  record: Record<string, unknown>,
  expected: NpmOperationReconciliationIdentity
): void {
  if (record.schemaVersion !== 1 || record.runId !== expected.runId
    || record.runAttempt !== expected.runAttempt
    || record.operation !== expected.operation || record.version !== expected.version
    || record.sourceCommit !== expected.sourceCommit) {
    throw new Error("npm operation journal has the wrong lease identity");
  }
}
function validateIdentity(value: NpmOperationReconciliationIdentity): void {
  try {
    requireNpmOperationIdentity(value);
  } catch (error) {
    throw new Error("npm operation reconciliation identity is invalid", {
      cause: error
    });
  }
}
function recordKeys(value: unknown): ReadonlySet<string> {
  const input = object(value, "npm operation journal record");
  const common = [
    "schemaVersion", "record", "runId", "runAttempt", "operation",
    "version", "sourceCommit", "parameters"
  ];
  if (input.record === "started") return new Set([...common, "registry", "packageOrder"]);
  if (input.record === "event") return new Set([...common, "event"]);
  if (input.record === "complete") return new Set([...common, "result"]);
  if (input.record === "failed") return new Set([...common, "failure"]);
  throw new Error("npm operation journal has an unknown record type");
}
function eventKeys(value: unknown): ReadonlySet<string> {
  const event = object(value, "npm operation event");
  if (event.kind === "before" || event.kind === "after") {
    return new Set(["kind", "states"]);
  }
  if (event.kind === "write-attempt") return new Set(["kind", "write"]);
  if (event.kind === "write-verified") return new Set(["kind", "write", "state"]);
  throw new Error("npm operation journal has an unknown event type");
}
function boundedJournal(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("npm operation journal path must be absolute");
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0
    || stat.size > NPM_OPERATION_JOURNAL_MAX_BYTES) {
    throw new Error("npm operation journal must be a bounded regular file");
  }
  const file = realpathSync(value);
  if (file !== value) throw new Error("npm operation journal path must be canonical");
  return file;
}

function exactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string
): Record<string, unknown> {
  const input = object(value, label);
  const actual = Object.keys(input);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw new Error(`${label} has unexpected fields`);
  }
  return input;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function canonicalName(value: unknown, order: readonly string[]): string {
  if (typeof value !== "string" || !order.includes(value)) {
    throw new Error("npm operation journal names an unsupported package");
  }
  return value;
}

function nonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value === "" || Buffer.byteLength(value) > 4096) {
    throw new Error(`${label} is invalid`);
  }
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new Error("npm operation journal is not UTF-8", { cause: error });
  }
}
