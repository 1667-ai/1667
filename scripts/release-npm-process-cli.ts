#!/usr/bin/env -S node --import tsx

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  assertNpmProcessQuiescent,
  type NpmProcessJournalIdentity
} from "./release-npm-process-journal.js";
import {
  inspectNpmRecoveryJournalState
} from "./release-npm-recovery-journals.js";

function main(args: readonly string[]): void {
  const [
    command, firstPath, secondPathOrRunId, runIdOrAttempt, attemptOrOperation,
    operationOrVersion, versionOrCommit, possibleCommit
  ] = args;
  const journalState = command === "journal-state";
  const journalPath = firstPath;
  const processJournalPath = journalState ? secondPathOrRunId : undefined;
  const runId = journalState ? runIdOrAttempt : secondPathOrRunId;
  const runAttempt = journalState ? attemptOrOperation : runIdOrAttempt;
  const operation = journalState ? operationOrVersion : attemptOrOperation;
  const version = journalState ? versionOrCommit : operationOrVersion;
  const sourceCommit = journalState ? possibleCommit : versionOrCommit;
  if ((command !== "quiescent" && !journalState)
    || args.length !== (journalState ? 8 : 7)
    || journalPath === undefined || runId === undefined || runAttempt === undefined
    || (operation !== "promotion" && operation !== "quarantine")
    || version === undefined || sourceCommit === undefined) {
    throw new Error(usage());
  }
  const identity: NpmProcessJournalIdentity = {
    runId,
    runAttempt,
    operation,
    version,
    sourceCommit
  };
  if (journalState) {
    if (processJournalPath === undefined) throw new Error(usage());
    process.stdout.write(`${inspectNpmRecoveryJournalState(
      journalPath,
      processJournalPath,
      identity
    )}\n`);
    return;
  }
  assertNpmProcessQuiescent(journalPath, identity);
  process.stdout.write(`${canonicalJson({ quiescent: true, ...identity })}\n`);
}

function usage(): string {
  return "usage: release-npm-process-cli.ts quiescent"
    + " <absolute-process-journal-path> <run-id> <run-attempt>"
    + " <promotion|quarantine> <version> <source-commit>"
    + " | release-npm-process-cli.ts journal-state"
    + " <absolute-operation-journal-path> <absolute-process-journal-path>"
    + " <run-id> <run-attempt> <promotion|quarantine> <version> <source-commit>";
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-process: ${message}\n`);
    process.exitCode = 1;
  }
}
