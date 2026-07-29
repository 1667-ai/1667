#!/usr/bin/env -S node --import tsx

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  recordNpmQuarantineNote,
  type NpmQuarantineNoteRequest
} from "./release-npm-quarantine-note.js";

async function main(args: readonly string[]): Promise<void> {
  const request = quarantineNoteRequest(args);
  const evidence = await recordNpmQuarantineNote(request);
  process.stdout.write(`${canonicalJson(evidence)}\n`);
}

function quarantineNoteRequest(
  args: readonly string[]
): NpmQuarantineNoteRequest {
  const [
    version,
    journalPath,
    evidencePath,
    runId,
    runAttempt,
    sourceCommit
  ] = args;
  if (args.length !== 6 || version === undefined || journalPath === undefined
    || evidencePath === undefined || runId === undefined
    || runAttempt === undefined || sourceCommit === undefined) {
    throw new Error(usage());
  }
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  return Object.freeze({
    repository,
    token: requiredEnvironment("GH_TOKEN"),
    claimSecret: requiredEnvironment("NPM_OPERATION_CLAIM_SECRET"),
    version,
    journalPath,
    evidencePath,
    lease: Object.freeze({
      repository,
      runId,
      runAttempt,
      operation: "quarantine" as const,
      version,
      sourceCommit
    })
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`npm quarantine note requires ${name}`);
  }
  return value;
}

function usage(): string {
  return "usage: release-npm-quarantine-note-cli.ts"
    + " <version> <absolute-journal-path> <absolute-evidence-path>"
    + " <run-id> <run-attempt> <source-commit>";
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
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-npm-quarantine-note: ${message}\n`);
    process.exitCode = 1;
  }
}
