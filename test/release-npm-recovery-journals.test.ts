import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import {
  NpmTagOperationJournal
} from "../scripts/release-npm-operation-journal.js";
import {
  NpmProcessJournal
} from "../scripts/release-npm-process-journal.js";
import {
  inspectNpmRecoveryJournalState
} from "../scripts/release-npm-recovery-journals.js";
import {
  npmReleaseOperationPackageOrder
} from "../scripts/release-npm-operations.js";

const IDENTITY = Object.freeze({
  runId: "123456789",
  runAttempt: "1",
  operation: "promotion" as const,
  version: "1.2.3",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567"
});
const PARAMETERS = Object.freeze({
  operation: "promotion" as const,
  promotion: Object.freeze({
    destination: "latest" as const,
    stableAcknowledged: false
  })
});
const CLI = path.resolve("scripts/release-npm-process-cli.ts");
const execFileAsync = promisify(execFile);

test("recovery journal state accepts a complete pair or complete absence", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  assert.equal(
    inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    "absent"
  );
  createOperationJournal(operationPath);
  new NpmProcessJournal(processPath, IDENTITY);
  assert.equal(
    inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    "present"
  );
});

test("recovery journal state accepts a valid pre-writer process journal", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  new NpmProcessJournal(processPath, IDENTITY);
  assert.equal(
    inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    "process-only"
  );
});

test("pre-writer process journal requires its exact lease identity", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  new NpmProcessJournal(processPath, IDENTITY);
  assert.throws(
    () => inspectNpmRecoveryJournalState(
      operationPath,
      processPath,
      { ...IDENTITY, runAttempt: "2" }
    ),
    /lease coordinates changed/u
  );
});

test("recovery journal state rejects an operation journal without a process journal",
  async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  createOperationJournal(operationPath);
  assert.throws(
    () => inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    /operation journal has no process journal/u
  );
});

test("pre-writer process journal must be complete and canonical", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  await writeFile(processPath, "not-json\n");
  assert.throws(
    () => inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    /expected null/u
  );
});

test("recovery journal state rejects malformed paired journals", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  await writeFile(operationPath, "not-json\n");
  new NpmProcessJournal(processPath, IDENTITY);
  assert.throws(
    () => inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    /expected null/u
  );
});

test("recovery journal state independently validates the process journal",
  async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  createOperationJournal(operationPath);
  await writeFile(processPath, "not-json\n");
  assert.throws(
    () => inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    /expected null/u
  );
});

test("absent recovery journals still require valid lease coordinates", async (t) => {
  const root = await temporaryRoot(t);
  assert.throws(
    () => inspectNpmRecoveryJournalState(
      path.join(root, "journal.jsonl"),
      path.join(root, "processes.jsonl"),
      { ...IDENTITY, runId: "0" }
    ),
    /lease coordinates are invalid/u
  );
});

test("absent journal proof requires separate canonical absolute paths", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  assert.throws(
    () => inspectNpmRecoveryJournalState(
      "journal.jsonl",
      path.join(root, "processes.jsonl"),
      IDENTITY
    ),
    /operation journal path must be absolute/u
  );
  assert.throws(
    () => inspectNpmRecoveryJournalState(operationPath, operationPath, IDENTITY),
    /must use separate paths/u
  );
  assert.throws(
    () => inspectNpmRecoveryJournalState(
      `${root}/../${path.basename(root)}/journal.jsonl`,
      path.join(root, "processes.jsonl"),
      IDENTITY
    ),
    /operation journal path must be canonical/u
  );
});

test("recovery journal absence does not follow symbolic links", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  await symlink(path.join(root, "missing-operation"), operationPath);
  await symlink(path.join(root, "missing-process"), processPath);
  assert.throws(
    () => inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    /bounded regular file/u
  );
});

test("process-only journal proof does not follow a symbolic link", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  const target = path.join(root, "process-target.jsonl");
  new NpmProcessJournal(target, IDENTITY);
  await symlink(target, processPath);
  assert.throws(
    () => inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    /cannot be a symbolic link/u
  );
});

test("journal-state CLI reports all strict states without creating files", async (t) => {
  const root = await temporaryRoot(t);
  const operationPath = path.join(root, "journal.jsonl");
  const processPath = path.join(root, "processes.jsonl");
  const command = [
    "--import", "tsx", CLI, "journal-state", operationPath, processPath,
    IDENTITY.runId, IDENTITY.runAttempt, IDENTITY.operation,
    IDENTITY.version, IDENTITY.sourceCommit
  ];
  const { stdout } = await execFileAsync(process.execPath, command);
  assert.equal(stdout, "absent\n");
  assert.equal(
    inspectNpmRecoveryJournalState(operationPath, processPath, IDENTITY),
    "absent"
  );
  new NpmProcessJournal(processPath, IDENTITY);
  const processOnly = await execFileAsync(process.execPath, command);
  assert.equal(processOnly.stdout, "process-only\n");
  createOperationJournal(operationPath);
  const present = await execFileAsync(process.execPath, command);
  assert.equal(present.stdout, "present\n");
});

function createOperationJournal(operationPath: string): void {
  const operationJournal = new NpmTagOperationJournal(
    operationPath,
    { ...IDENTITY, parameters: PARAMETERS },
    npmReleaseOperationPackageOrder("promotion")
  );
  operationJournal.close();
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-npm-recovery-"))
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
