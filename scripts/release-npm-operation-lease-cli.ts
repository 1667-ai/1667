#!/usr/bin/env -S node --import tsx

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseOperation,
  type NpmOperationLeaseRequest
} from "./release-npm-operation-lease.js";

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const client = new GitHubNpmOperationLease({
    repository,
    token: requiredEnvironment("GH_TOKEN"),
    ...(command === "holder"
      ? { lockStartedAtMs: lockStartedAt() }
      : {})
  });
  if (command === "authorize" && args.length === 4) {
    await client.authorizeDispatch(
      workflowRequest(repository, args.slice(0, 3)),
      args[3]!
    );
    return;
  }
  if (command === "holder" && args.length === 3) {
    const request = workflowRequest(repository, args);
    const terminal = await client.startAndPoll(request);
    process.stdout.write(`${canonicalJson({ terminal, ...request })}\n`);
    process.exitCode = holderExitCode(terminal);
    return;
  }
  if (command === "assert-clear" && args.length === 0) {
    await client.assertNoActiveWithVerifiedControls();
    return;
  }
  if (command === "open-state" && args.length === 0) {
    process.stdout.write(`${canonicalJson(await client.openState())}\n`);
    return;
  }
  const request = cliRequest(repository, args);
  if (command === "claim") {
    const secret = newSecret();
    await client.claim(request, secret);
    process.stdout.write(`${secret}\n`);
  } else if (command === "writer") {
    const secret = newSecret();
    await client.acquireWriter(request, claimSecret(), secret);
    process.stdout.write(`${secret}\n`);
  } else if (command === "verify-writer") {
    await client.verifyWriter(request, writerSecret());
  } else if (command === "quarantine-marker") {
    await client.createQuarantineMarker(request, claimSecret());
  } else if (command === "writer-success" || command === "writer-failed") {
    await client.acknowledgeWriter(
      request,
      writerSecret(),
      command === "writer-success" ? "success" : "failed"
    );
  } else if (command === "revoke") {
    await client.revoke(request);
  } else if (command === "cleanup-open") {
    await client.cleanupOpen(request);
  } else if (command === "abandoned") {
    await client.abandon(request);
  } else if (command === "no-writer") {
    await client.assertNoWriterAfterRevocation(request);
  } else if (command === "writer-outcome") {
    process.stdout.write(`${await client.writerOutcome(request) ?? "none"}\n`);
  } else if (command === "verify") {
    await client.verifyClaim(request, claimSecret());
  } else if (command === "complete") {
    await client.complete(request, claimSecret());
  } else if (command === "failed") {
    await client.fail(request, claimSecret());
  } else {
    throw new Error(usage());
  }
}

function workflowRequest(
  repository: string,
  args: readonly string[]
): NpmOperationLeaseRequest {
  return {
    repository,
    runId: requiredEnvironment("GITHUB_RUN_ID"),
    runAttempt: requiredEnvironment("GITHUB_RUN_ATTEMPT"),
    operation: operation(args[0]),
    version: args[1]!,
    sourceCommit: args[2]!
  };
}

function claimSecret(): string {
  return requiredEnvironment("NPM_OPERATION_CLAIM_SECRET");
}

function writerSecret(): string {
  return requiredEnvironment("NPM_OPERATION_WRITER_SECRET");
}

function newSecret(): string {
  return randomBytes(32).toString("hex");
}

function lockStartedAt(): number {
  const value = requiredEnvironment("NPM_OPERATION_LOCK_STARTED_AT_MS");
  if (!/^\d{13}$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("npm operation holder lock start is invalid");
  }
  return Number(value);
}

function cliRequest(
  repository: string,
  args: readonly string[]
): NpmOperationLeaseRequest {
  const [runId, runAttempt, rawOperation, version, sourceCommit] = args;
  if (args.length !== 5 || runId === undefined || runAttempt === undefined
    || rawOperation === undefined || version === undefined
    || sourceCommit === undefined) {
    throw new Error(usage());
  }
  return {
    repository,
    runId,
    runAttempt,
    operation: operation(rawOperation),
    version,
    sourceCommit
  };
}

function operation(value: string | undefined): NpmOperationLeaseOperation {
  if (value !== "promotion" && value !== "quarantine") {
    throw new Error(usage());
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`npm operation lease requires ${name}`);
  }
  return value;
}

function usage(): string {
  return "usage: release-npm-operation-lease-cli.ts"
    + " authorize <promotion|quarantine> <version> <source-commit> <dispatcher>"
    + " | release-npm-operation-lease-cli.ts"
    + " holder <promotion|quarantine> <version> <source-commit>"
    + " | release-npm-operation-lease-cli.ts <assert-clear|open-state>"
    + " | release-npm-operation-lease-cli.ts"
    + " <claim|writer|verify|verify-writer|writer-success|writer-failed"
    + "|writer-outcome|quarantine-marker|complete|failed|revoke|no-writer"
    + "|cleanup-open|abandoned>"
    + " <run-id> <run-attempt> <promotion|quarantine> <version> <source-commit>";
}

export function holderExitCode(
  terminal: "complete" | "failed" | "abandoned"
): 0 | 1 {
  return terminal === "complete" ? 0 : 1;
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
    process.stderr.write(`release-npm-operation-lease: ${message}\n`);
    process.exitCode = 1;
  }
}
