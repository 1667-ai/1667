import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeSync
} from "node:fs";
import path from "node:path";
import { canonicalJson } from "../server/canonical-json.js";
import { parseJsonRejectingDuplicateKeys } from "../shared/strict-json.js";
import {
  requireNpmOperationIdentity,
  type NpmOperationIdentity
} from "./release-npm-operation-identity.js";

const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_JOURNAL_LINE_BYTES = 64 * 1024;

export type NpmProcessJournalIdentity = NpmOperationIdentity;

export interface NpmProcessToolIdentity {
  readonly node: { readonly path: string; readonly sha256: string };
  readonly npmCli: { readonly path: string; readonly sha256: string };
  readonly runner: { readonly path: string; readonly sha256: string };
}

export interface NpmProcessStarted {
  readonly pid: number;
  readonly nonce: string;
  readonly tool: NpmProcessToolIdentity;
  readonly arguments: readonly string[];
  readonly npmCommand: readonly string[];
}

export interface NpmProcessTerminal {
  readonly pid: number;
  readonly nonce: string;
  readonly outcome: "success" | "failed" | "timed-out";
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface NpmProcessQuiescence {
  readonly ownerPid: number;
  readonly ownerActive: boolean;
  readonly active: readonly NpmProcessStarted[];
}

export class NpmProcessJournal {
  #bytes = 0;
  #writable = true;
  readonly path: string;
  readonly identity: NpmProcessJournalIdentity;

  constructor(file: string, identity: NpmProcessJournalIdentity) {
    this.path = canonicalPath(file);
    this.identity = validateIdentity(identity);
    const descriptor = openSync(
      this.path,
      constants.O_APPEND | constants.O_CREAT | constants.O_EXCL
        | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const bytes = recordBytes({
        schemaVersion: 1,
        record: "opened",
        ownerPid: process.pid,
        ...this.identity
      });
      writeRecord(descriptor, bytes);
      this.#bytes = bytes.length;
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(path.dirname(this.path));
  }

  started(record: NpmProcessStarted): void {
    validateStarted(record);
    this.#append({ schemaVersion: 1, record: "started", ...this.identity, ...record });
  }

  terminal(record: NpmProcessTerminal): void {
    validateTerminal(record);
    this.#append({ schemaVersion: 1, record: "terminal", ...this.identity, ...record });
  }

  #append(record: unknown): void {
    if (!this.#writable) {
      throw new Error("npm process journal refuses writes after an append failure");
    }
    try {
      const bytes = recordBytes(record);
      if (bytes.length > MAX_JOURNAL_BYTES - this.#bytes) {
        throw new Error("npm process journal exceeds the recovery size bound");
      }
      const descriptor = openSync(
        this.path,
        constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW
      );
      try {
        writeRecord(descriptor, bytes);
        this.#bytes += bytes.length;
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      this.#writable = false;
      throw error;
    }
  }
}

export function inspectNpmProcessQuiescence(
  file: string,
  identity: NpmProcessJournalIdentity
): NpmProcessQuiescence {
  const expected = validateIdentity(identity);
  const value = canonicalPath(file);
  const stat = statSync(value);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_JOURNAL_BYTES) {
    throw new Error("npm process journal has an invalid size");
  }
  const contents = readFileSync(value, "utf8");
  if (!contents.endsWith("\n")) {
    throw new Error("npm process journal has an incomplete final record");
  }
  const lines = contents.slice(0, -1).split("\n");
  const active = new Map<string, NpmProcessStarted>();
  let ownerPid: number | null = null;
  let opened = false;
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_JOURNAL_LINE_BYTES) {
      throw new Error("npm process journal line exceeds the bound");
    }
    const parsed = parseJsonRejectingDuplicateKeys(line);
    if (canonicalJson(parsed) !== line) {
      throw new Error("npm process journal record is not canonical");
    }
    const record = object(parsed, "npm process journal record");
    requireRecordIdentity(record, expected);
    if (record.record === "opened") {
      requireExactKeys(record, [
        "schemaVersion", "record",
        "runId", "runAttempt", "operation", "version", "sourceCommit", "ownerPid"
      ], "opened");
      if (opened || active.size !== 0) {
        throw new Error("npm process journal repeats its opened record");
      }
      ownerPid = processPid(record.ownerPid, "owner");
      opened = true;
    } else if (record.record === "started") {
      requireExactKeys(record, [
        "schemaVersion", "record",
        "runId", "runAttempt", "operation", "version", "sourceCommit",
        "pid", "nonce", "tool", "arguments", "npmCommand"
      ], "started");
      if (!opened) throw new Error("npm process journal has no opened record");
      const started = parseStarted(record);
      if (active.has(started.nonce)) {
        throw new Error("npm process journal repeats a process nonce");
      }
      active.set(started.nonce, started);
    } else if (record.record === "terminal") {
      requireExactKeys(record, [
        "schemaVersion", "record",
        "runId", "runAttempt", "operation", "version", "sourceCommit",
        "pid", "nonce", "outcome", "code", "signal"
      ], "terminal");
      const terminal = parseTerminal(record);
      const started = active.get(terminal.nonce);
      if (started === undefined || started.pid !== terminal.pid) {
        throw new Error("npm process journal terminal has no matching start");
      }
      active.delete(terminal.nonce);
    } else {
      throw new Error("npm process journal record type is invalid");
    }
  }
  if (!opened || ownerPid === null) {
    throw new Error("npm process journal has no opened record");
  }
  const live = [...active.values()].filter((record) => processIsLive(record.pid));
  return Object.freeze({
    ownerPid,
    ownerActive: ownerPid !== process.pid && processIsLive(ownerPid),
    active: Object.freeze(live)
  });
}

export function assertNpmProcessQuiescent(
  file: string,
  identity: NpmProcessJournalIdentity
): void {
  const result = inspectNpmProcessQuiescence(file, identity);
  if (result.ownerActive) {
    throw new Error(`npm operation owner ${result.ownerPid} is active`);
  }
  if (result.active.length !== 0) {
    throw new Error(
      `npm process ${result.active[0]!.pid} (${result.active[0]!.nonce}) is active`
    );
  }
}

export function requireNpmProcessJournalIdentity(
  identity: NpmProcessJournalIdentity
): NpmProcessJournalIdentity {
  return validateIdentity(identity);
}

function processPid(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`npm process ${label} PID is invalid`);
  }
  return value as number;
}

function parseStarted(record: Record<string, unknown>): NpmProcessStarted {
  const value = {
    pid: record.pid,
    nonce: record.nonce,
    tool: record.tool,
    arguments: record.arguments,
    npmCommand: record.npmCommand
  } as unknown as NpmProcessStarted;
  validateStarted(value);
  return Object.freeze({
    ...value,
    arguments: Object.freeze([...value.arguments]),
    npmCommand: Object.freeze([...value.npmCommand])
  });
}

function parseTerminal(record: Record<string, unknown>): NpmProcessTerminal {
  const value = {
    pid: record.pid,
    nonce: record.nonce,
    outcome: record.outcome,
    code: record.code,
    signal: record.signal
  } as unknown as NpmProcessTerminal;
  validateTerminal(value);
  return value;
}

function validateStarted(value: NpmProcessStarted): void {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.nonce !== "string" || !DIGEST.test(value.nonce)) {
    throw new Error("npm process start identity is invalid");
  }
  const tool = object(value.tool, "npm process tool identity");
  requireExactKeys(tool, ["node", "npmCli", "runner"], "tool identity");
  const node = toolEntry(tool.node, "Node");
  const npmCli = toolEntry(tool.npmCli, "npm CLI");
  toolEntry(tool.runner, "runner");
  const arguments_ = stringArray(value.arguments, "npm process arguments");
  const command = stringArray(value.npmCommand, "npm process command");
  const expected = [
    node.path,
    npmCli.path,
    `--user-agent=1667-npm-operation-${value.nonce}`,
    ...arguments_
  ];
  if (command.length !== expected.length
    || command.some((part, index) => part !== expected[index])) {
    throw new Error("npm process command does not bind its tool and nonce");
  }
}

function validateTerminal(value: NpmProcessTerminal): void {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.nonce !== "string" || !DIGEST.test(value.nonce)
    || (value.outcome !== "success" && value.outcome !== "failed"
      && value.outcome !== "timed-out")
    || (value.code !== null && (!Number.isSafeInteger(value.code) || value.code < 0))
    || (value.signal !== null && typeof value.signal !== "string")) {
    throw new Error("npm process terminal identity is invalid");
  }
}

function toolEntry(value: unknown, label: string): { path: string; sha256: string } {
  const entry = object(value, `npm process ${label} tool`);
  requireExactKeys(entry, ["path", "sha256"], `${label} tool identity`);
  if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)
    || typeof entry.sha256 !== "string" || !DIGEST.test(entry.sha256)) {
    throw new Error(`npm process ${label} tool identity is invalid`);
  }
  return entry as { path: string; sha256: string };
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128
    || value.some((part) => typeof part !== "string"
      || Buffer.byteLength(part) > 16 * 1024)) {
    throw new Error(`${label} is invalid`);
  }
  return value as string[];
}

function validateIdentity(
  identity: NpmProcessJournalIdentity
): NpmProcessJournalIdentity {
  try {
    return requireNpmOperationIdentity(identity);
  } catch (error) {
    throw new Error("npm process journal lease coordinates are invalid", {
      cause: error
    });
  }
}

function requireRecordIdentity(
  record: Record<string, unknown>,
  identity: NpmProcessJournalIdentity
): void {
  if (record.schemaVersion !== 1) {
    throw new Error("npm process journal schema version is invalid");
  }
  for (const key of [
    "runId", "runAttempt", "operation", "version", "sourceCommit"
  ] as const) {
    if (record[key] !== identity[key]) {
      throw new Error("npm process journal lease coordinates changed");
    }
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length
    || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`npm process journal ${label} fields are invalid`);
  }
}

function canonicalPath(value: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error("npm process journal path must be absolute");
  }
  const parent = realpathSync(path.dirname(value));
  const canonical = path.join(parent, path.basename(value));
  if (canonical !== value) throw new Error("npm process journal path must be canonical");
  const existing = lstatSync(value, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new Error("npm process journal cannot be a symbolic link");
  }
  return canonical;
}

function recordBytes(record: unknown): Buffer {
  const bytes = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
  if (bytes.length - 1 > MAX_JOURNAL_LINE_BYTES) {
    throw new Error("npm process journal line exceeds the recovery bound");
  }
  return bytes;
}

function writeRecord(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("npm process journal write did not progress");
    offset += written;
  }
  fsyncSync(descriptor);
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new Error("npm process liveness check failed", { cause: error });
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
