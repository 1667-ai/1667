#!/usr/bin/env -S node --import tsx

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../server/canonical-json.js";
import {
  NpmTagOperationJournal,
  type NpmTagObservationError
} from "./release-npm-operation-journal.js";
import {
  reconcileNpmTagOperation,
  type NpmOperationReconciliationIdentity
} from "./release-npm-operation-reconciliation.js";
import {
  npmReleaseOperationPackageOrder,
  validateNpmPromotionRequest,
  validateNpmQuarantineRequest,
  type NpmPackageTagState,
  type NpmPromotionRequest,
  type NpmQuarantineRequest,
  type NpmReleaseOperation,
  type NpmTagRegistry
} from "./release-npm-operations.js";
import {
  GitHubNpmOperationLease,
  type NpmOperationLeaseRequest
} from "./release-npm-operation-lease.js";
import {
  requireNpmOperationLeaseRequest
} from "./release-npm-operation-lease-state.js";
import { PublicNpmTagRegistry } from "./release-npm-tag-registry.js";
import {
  NpmWriteAccessVerifier,
  type NpmWriteAccess
} from "./release-npm-access.js";
import {
  assertNpmProcessQuiescent,
  NpmProcessJournal
} from "./release-npm-process-journal.js";
import {
  PublicNpmSupersedingReleaseVerifier,
  type NpmSupersedingReleaseVerifier
} from "./release-npm-superseding-release.js";
import { isSemVer } from "../shared/semver.js";
import {
  recoverNpmTagOperation,
  startNpmTagOperationLifecycle,
  type NpmTagOperationLifecycle
} from "./release-npm-tag-operation-lifecycle.js";
import {
  createNpmTagOperationBehavior
} from "./release-npm-tag-operation-behavior.js";
import type {
  NpmTagOperationLease,
  OperationCliRequest
} from "./release-npm-tag-operation-contracts.js";

export type {
  NpmTagOperationLease,
  OperationCliRequest
} from "./release-npm-tag-operation-contracts.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "packages"
    && (args[0] === "promotion" || args[0] === "quarantine")
    && args.length === 1) {
    process.stdout.write(
      `${npmReleaseOperationPackageOrder(args[0]).join("\n")}\n`
    );
  } else if (command === "promote" || command === "quarantine") {
    await runNpmTagOperation(operationRequest(command, args));
  } else if (command === "reconcile") {
    await runReconciliation(args);
  } else {
    throw new Error(usage());
  }
}

export interface NpmTagOperationDependencies {
  readonly lease?: NpmTagOperationLease;
  readonly access?: NpmWriteAccess;
  readonly registry?: (
    authorizeWrite: () => Promise<void>
  ) => NpmTagRegistry;
  readonly processJournal?: NpmProcessJournal;
  readonly assertProcessQuiescent?: () => void;
  readonly supersedingRelease?: NpmSupersedingReleaseVerifier;
}

export async function runNpmTagOperation(
  request: OperationCliRequest,
  dependencies: NpmTagOperationDependencies = {}
): Promise<void> {
  requireOperationRequestBinding(request);
  const {
    version,
    evidencePath,
    processJournalPath,
    lease: leaseRequest,
    parameters
  } = request;
  const operation = parameters.operation;
  const order = npmReleaseOperationPackageOrder(operation);
  const lease = dependencies.lease ?? new GitHubNpmOperationLease({
    repository: leaseRequest.repository,
    token: requiredEnvironment("GH_TOKEN")
  });
  const access = dependencies.access ?? new NpmWriteAccessVerifier({
    environment: process.env,
    nodeExecutable: requiredEnvironment("npm_node_execpath"),
    npmCli: requiredEnvironment("npm_execpath")
  });
  const claimSecret = requiredEnvironment("NPM_OPERATION_CLAIM_SECRET");
  const processIdentity = {
    runId: leaseRequest.runId,
    runAttempt: leaseRequest.runAttempt,
    operation,
    version,
    sourceCommit: leaseRequest.sourceCommit
  } as const;
  const processJournal = dependencies.processJournal
    ?? new NpmProcessJournal(processJournalPath, processIdentity);
  requireProcessJournalIdentity(processJournal, processJournalPath, processIdentity);
  const journal = new NpmTagOperationJournal(
    evidencePath,
    { ...processIdentity, parameters },
    order
  );
  const writerSecret = randomBytes(32).toString("hex");
  const requireQuiescence = dependencies.assertProcessQuiescent ?? (() => {
    assertNpmProcessQuiescent(processJournalPath, processIdentity);
  });
  const beforeWriter = startNpmTagOperationLifecycle();
  let lifecycle: NpmTagOperationLifecycle = beforeWriter;
  try {
    const behavior = createNpmTagOperationBehavior(
      request,
      dependencies.supersedingRelease,
      () => new PublicNpmSupersedingReleaseVerifier({
        repository: request.lease.repository,
        token: requiredEnvironment("GH_TOKEN"),
        environment: process.env
      }),
      lease,
      access,
      writerSecret,
      order
    );
    await lease.acquireWriter(leaseRequest, claimSecret, writerSecret);
    const writerAcquired = beforeWriter.writerAcquired();
    lifecycle = writerAcquired;
    const registry = dependencies.registry?.(behavior.authorizeWrite)
      ?? new PublicNpmTagRegistry({
        environment: process.env,
        authorizeWrite: behavior.authorizeWrite,
        processJournal
      });
    const registryReady = writerAcquired.registryReady(registry);
    lifecycle = registryReady;
    const evidence = await behavior.execute(registry, journal);
    journal.complete(evidence);
    lifecycle = registryReady.journalCompleted();
    requireQuiescence();
    await lease.acknowledgeWriter(leaseRequest, writerSecret, "success");
    if (request.command === "promote") {
      await lease.complete(leaseRequest, claimSecret);
    }
  } catch (error) {
    await recoverNpmTagOperation(lifecycle, error, {
      recordFailureBeforeRegistry: async (operationError) => {
        const observation = failedObservation(
          order,
          "npm registry observation did not start"
        );
        journal.fail(
          errorMessage(operationError),
          observation.states,
          observation.errors
        );
      },
      recordFailureAfterRegistry: async (operationError, registry) => {
        const observation = isSemVer(version)
          ? await observeRegistry(registry, order, version)
          : failedObservation(order, "npm registry observation did not start");
        journal.fail(
          errorMessage(operationError),
          observation.states,
          observation.errors
        );
      },
      acknowledgeFailure: async () => {
        requireQuiescence();
        await lease.acknowledgeWriter(leaseRequest, writerSecret, "failed");
      },
      failLease: async () => {
        await lease.fail(leaseRequest, claimSecret);
      }
    });
  } finally {
    journal.close();
  }
}

function operationRequest(
  command: "promote" | "quarantine",
  args: readonly string[]
): OperationCliRequest {
  if (command === "promote") {
    const [
      version,
      destination,
      evidencePath,
      processJournalPath,
      runId,
      runAttempt,
      sourceCommit,
      acknowledgment
    ] = args;
    if (version === undefined || destination === undefined || evidencePath === undefined
      || processJournalPath === undefined || runId === undefined
      || runAttempt === undefined || sourceCommit === undefined
      || args.length < 7 || args.length > 8) {
      throw new Error(usage());
    }
    requireProcessJournalPath(processJournalPath, evidencePath);
    const promotion = validateNpmPromotionRequest({
      destination: destination as NpmPromotionRequest["destination"],
      stableAcknowledged: acknowledgment === "--acknowledge-stable"
    });
    if ((promotion.destination === "stable" && acknowledgment !== "--acknowledge-stable")
      || (promotion.destination !== "stable" && acknowledgment !== undefined)) {
      throw new Error(usage());
    }
    return Object.freeze({
      command,
      version,
      evidencePath,
      processJournalPath,
      lease: operationLeaseRequest(command, version, runId, runAttempt, sourceCommit),
      parameters: Object.freeze({ operation: "promotion" as const, promotion })
    });
  }
  const [
    version,
    incidentReference,
    supersedingVersion,
    evidencePath,
    processJournalPath,
    runId,
    runAttempt,
    sourceCommit
  ] = args;
  if (args.length !== 8 || version === undefined || incidentReference === undefined
    || supersedingVersion === undefined || evidencePath === undefined
    || processJournalPath === undefined || runId === undefined
    || runAttempt === undefined || sourceCommit === undefined) {
    throw new Error(usage());
  }
  requireProcessJournalPath(processJournalPath, evidencePath);
  const quarantine = validateNpmQuarantineRequest(version, {
    incidentReference,
    supersedingVersion
  });
  return Object.freeze({
    command,
    version,
    evidencePath,
    processJournalPath,
    lease: operationLeaseRequest(command, version, runId, runAttempt, sourceCommit),
    parameters: Object.freeze({ operation: "quarantine" as const, quarantine })
  });
}

function requireOperationRequestBinding(request: OperationCliRequest): void {
  const operation = operationForCommand(
    (request as { readonly command: unknown }).command
  );
  if (request.parameters.operation !== operation
    || request.lease.operation !== operation
    || request.lease.version !== request.version) {
    throw new Error("npm operation request coordinates do not match");
  }
  requireNpmOperationLeaseRequest(
    request.lease,
    request.lease.repository
  );
}

function operationForCommand(command: unknown): NpmReleaseOperation {
  if (command === "promote") return "promotion";
  if (command === "quarantine") return "quarantine";
  throw new Error("npm operation command is invalid");
}

function requireProcessJournalPath(value: string, evidencePath: string): void {
  if (!path.isAbsolute(value) || !path.isAbsolute(evidencePath)
    || value === evidencePath
    || realpathSync(path.dirname(value)) !== realpathSync(path.dirname(evidencePath))) {
    throw new Error(
      "npm process journal must use a separate absolute path beside the evidence"
    );
  }
}

function requireProcessJournalIdentity(
  journal: NpmProcessJournal,
  expectedPath: string,
  expectedIdentity: NpmProcessJournal["identity"]
): void {
  if (journal.path !== expectedPath
    || Object.entries(expectedIdentity).some(([key, value]) => {
      return journal.identity[key as keyof typeof expectedIdentity] !== value;
    })) {
    throw new Error("npm process journal does not match the operation");
  }
}

async function runReconciliation(args: readonly string[]): Promise<void> {
  const [journalPath, runId, runAttempt, operation, version, sourceCommit] = args;
  if (args.length !== 6 || journalPath === undefined || runId === undefined
    || runAttempt === undefined || (operation !== "promotion" && operation !== "quarantine")
    || version === undefined || sourceCommit === undefined) {
    throw new Error(usage());
  }
  const identity: NpmOperationReconciliationIdentity = {
    runId,
    runAttempt,
    operation,
    version,
    sourceCommit
  };
  const registry = new PublicNpmTagRegistry({
    environment: process.env,
    authorizeWrite: async () => {
      throw new Error("npm operation reconciliation cannot authorize a write");
    }
  });
  const result = await reconcileNpmTagOperation(journalPath, identity, registry);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

function operationLeaseRequest(
  command: "promote",
  version: string,
  runId: string,
  runAttempt: string,
  sourceCommit: string
): NpmOperationLeaseRequest & { readonly operation: "promotion" };
function operationLeaseRequest(
  command: "quarantine",
  version: string,
  runId: string,
  runAttempt: string,
  sourceCommit: string
): NpmOperationLeaseRequest & { readonly operation: "quarantine" };
function operationLeaseRequest(
  command: "promote" | "quarantine",
  version: string,
  runId: string,
  runAttempt: string,
  sourceCommit: string
): NpmOperationLeaseRequest {
  return Object.freeze({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    runId,
    runAttempt,
    operation: command === "promote" ? "promotion" : "quarantine",
    version,
    sourceCommit
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`release npm operations require ${name}`);
  }
  return value;
}

async function observeRegistry(
  registry: NpmTagRegistry,
  order: readonly string[],
  version: string
): Promise<{
  readonly states: readonly NpmPackageTagState[];
  readonly errors: readonly NpmTagObservationError[];
}> {
  const states: NpmPackageTagState[] = [];
  const errors: NpmTagObservationError[] = [];
  for (const name of order) {
    try {
      states.push(await registry.inspect(name, version));
    } catch (error) {
      errors.push(Object.freeze({ name, message: errorMessage(error) }));
    }
  }
  return Object.freeze({
    states: Object.freeze(states),
    errors: Object.freeze(errors)
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedObservation(
  order: readonly string[],
  message: string
): {
  readonly states: readonly NpmPackageTagState[];
  readonly errors: readonly NpmTagObservationError[];
} {
  return Object.freeze({
    states: Object.freeze([]),
    errors: Object.freeze(order.map((name) => Object.freeze({ name, message })))
  });
}

function usage(): string {
  return "usage: release-npm-operations-cli.ts packages <promotion|quarantine>"
    + " | release-npm-operations-cli.ts promote <version> <latest|stable|beta>"
    + " <absolute-evidence-path> <absolute-process-journal-path>"
    + " <run-id> <run-attempt> <source-commit>"
    + " [--acknowledge-stable]"
    + " | release-npm-operations-cli.ts quarantine <version>"
    + " <incident-reference> <superseding-version> <absolute-evidence-path>"
    + " <absolute-process-journal-path> <run-id> <run-attempt> <source-commit>"
    + " | release-npm-operations-cli.ts reconcile <absolute-journal-path>"
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
    await main();
  } catch (error) {
    process.stderr.write(`release-npm-operations: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
