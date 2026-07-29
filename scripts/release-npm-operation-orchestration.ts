import { randomBytes, randomUUID } from "node:crypto";
import {
  requireNpmOperationLeaseRequest,
  type NpmOperationLeaseOperation,
  type NpmOperationLeaseRequest,
  type NpmOperationOpenState
} from "./release-npm-operation-lease-state.js";
import {
  requireNpmOperationHolderJob,
  requireNpmOperationHolderRun
} from "./release-npm-operation-holder-authorization.js";
import type {
  NpmOperationWorkflow,
  NpmOperationWorkflowClient,
  NpmOperationWorkflowRun
} from "./release-npm-operation-workflows.js";
import {
  NPM_OPERATION_REVOCATION_SETTLE_MS
} from "./release-npm-operation-revocation-settlement.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 1_800;
const DEFAULT_MAX_OPEN_OPERATIONS = 100;
const WAITING_JOB_STATES = new Set([
  "queued", "pending", "requested", "waiting"
]);

export interface NpmOperationAuthority {
  readonly request: NpmOperationLeaseRequest;
  readonly claimSecret: string;
  readonly stateDirectory: string;
  readonly operationJournal: string;
  readonly processJournal: string;
  readonly reconciliationRecord: string;
}

export interface NpmOperationStatePaths {
  readonly stateDirectory: string;
  readonly operationJournal: string;
  readonly processJournal: string;
  readonly reconciliationRecord: string;
}

export interface NpmOperationStateStore {
  prepareRoot(): Promise<void>;
  paths(request: NpmOperationLeaseRequest): Promise<NpmOperationStatePaths>;
}

export interface NpmOperationWorkspace {
  verifyProtectedMain(expectedCommit?: string): Promise<void>;
}

export interface NpmOperationLeaseOrchestrator {
  claim(request: NpmOperationLeaseRequest, secret: string): Promise<void>;
  openState(): Promise<NpmOperationOpenState | null>;
  revoke(request: NpmOperationLeaseRequest): Promise<void>;
  abandon(request: NpmOperationLeaseRequest): Promise<void>;
  cleanupOpen(request: NpmOperationLeaseRequest): Promise<void>;
  assertNoActiveWithVerifiedControls(): Promise<void>;
}

export interface NpmOperationOrchestrationDependencies {
  readonly repository: string;
  readonly workflows: NpmOperationWorkflowClient;
  readonly lease: NpmOperationLeaseOrchestrator;
  readonly state: NpmOperationStateStore;
  readonly workspace: NpmOperationWorkspace;
  readonly verifyControls: () => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  readonly maxOpenOperations?: number;
  readonly requestId?: () => string;
  readonly claimSecret?: () => string;
}

export async function acquireNpmOperation(
  operation: NpmOperationLeaseOperation,
  version: string,
  sourceCommit: string,
  dependencies: NpmOperationOrchestrationDependencies
): Promise<NpmOperationAuthority> {
  const limits = orchestrationLimits(dependencies);
  await dependencies.workspace.verifyProtectedMain();
  await dependencies.verifyControls();
  await dependencies.state.prepareRoot();
  const requestId = (dependencies.requestId ?? randomUUID)();
  requireRequestId(requestId);
  const expectedTitle = `npm ${operation} v${version}`
    + ` (${requestId}; source ${sourceCommit})`;
  await dependencies.workflows.dispatchHolder({
    operation,
    version,
    sourceCommit,
    requestId
  });
  const summary = await findHolder(
    dependencies.workflows,
    expectedTitle,
    limits
  );
  if (summary.attempt !== "1") {
    throw new Error("npm operation holder must start at attempt 1");
  }
  const request = requireNpmOperationLeaseRequest({
    repository: dependencies.repository,
    runId: summary.id,
    runAttempt: summary.attempt,
    operation,
    version,
    sourceCommit
  }, dependencies.repository);
  await waitForHoldJob(dependencies.workflows, request, limits);
  const secret = (dependencies.claimSecret
    ?? (() => randomBytes(32).toString("hex")))();
  requireClaimSecret(secret);
  await dependencies.lease.claim(request, secret);
  const holder = await dependencies.workflows.run(request.runId);
  await dependencies.workspace.verifyProtectedMain(holder.head_sha);
  requireNpmOperationHolderRun(holder, request, {
    ref: "refs/heads/main",
    object: { type: "commit", sha: holder.head_sha }
  });
  const paths = await dependencies.state.paths(request);
  return Object.freeze({
    request,
    claimSecret: secret,
    ...paths
  });
}

export async function stopActiveNpmOperations(
  dependencies: NpmOperationOrchestrationDependencies
): Promise<void> {
  const limits = orchestrationLimits(dependencies);
  await dependencies.workspace.verifyProtectedMain();
  await dependencies.verifyControls();
  await cancelWorkflowRuns(
    dependencies.workflows,
    "release-npm.yml",
    limits
  );
  await cancelWorkflowRuns(
    dependencies.workflows,
    "release-npm-operation.yml",
    limits
  );
  for (let count = 0; count < limits.maxOpenOperations; count += 1) {
    const open = await dependencies.lease.openState();
    if (open === null) {
      await dependencies.lease.assertNoActiveWithVerifiedControls();
      return;
    }
    const request = requireNpmOperationLeaseRequest(
      open.request,
      dependencies.repository
    );
    if (open.state === "terminal") {
      await dependencies.lease.cleanupOpen(request);
      continue;
    }
    if (open.state === "active") {
      try {
        await dependencies.lease.revoke(request);
      } catch (error) {
        const raced = await dependencies.lease.openState();
        if (raced?.state !== "terminal"
          || !sameRequest(raced.request, request)) {
          throw error;
        }
        continue;
      }
    }
    await cancelRun(
      dependencies.workflows,
      request.runId,
      true,
      limits
    );
    if (open.state === "pre-active") {
      await dependencies.lease.cleanupOpen(request);
      continue;
    }
    await limits.sleep(NPM_OPERATION_REVOCATION_SETTLE_MS);
    await dependencies.lease.abandon(request);
  }
  throw new Error("npm operation open leases exceed the recovery bound");
}

async function findHolder(
  workflows: NpmOperationWorkflowClient,
  expectedTitle: string,
  limits: OrchestrationLimits
): Promise<NpmOperationWorkflowRun> {
  for (let poll = 0; poll < limits.maxPolls; poll += 1) {
    const matching = (await workflows.runs("release-npm-operation.yml"))
      .filter((run) => run.displayTitle === expectedTitle);
    if (matching.length > 1) {
      throw new Error("More than one npm operation holder matches the request");
    }
    if (matching.length === 1) return matching[0]!;
    await limits.sleep(limits.pollIntervalMs);
  }
  throw new Error("npm operation holder did not appear before the polling bound");
}

async function waitForHoldJob(
  workflows: NpmOperationWorkflowClient,
  request: NpmOperationLeaseRequest,
  limits: OrchestrationLimits
): Promise<void> {
  for (let poll = 0; poll < limits.maxPolls; poll += 1) {
    const jobs = await workflows.jobs(request.runId);
    const matching = jobs.filter((job) => job.name === "hold");
    if (matching.length > 1) {
      throw new Error("npm operation holder has more than one hold job");
    }
    if (matching.length === 0) {
      if ((await workflows.run(request.runId)).status === "completed") {
        throw new Error("npm operation holder completed before its hold job started");
      }
      await limits.sleep(limits.pollIntervalMs);
      continue;
    }
    const job = matching[0]!;
    if (job.status === "in_progress") {
      requireNpmOperationHolderJob(jobs, request);
      return;
    }
    if (!WAITING_JOB_STATES.has(job.status)) {
      throw new Error("npm operation hold job entered an unsafe state");
    }
    await limits.sleep(limits.pollIntervalMs);
  }
  throw new Error("npm operation hold job did not start before the polling bound");
}

async function cancelWorkflowRuns(
  workflows: NpmOperationWorkflowClient,
  workflow: NpmOperationWorkflow,
  limits: OrchestrationLimits
): Promise<void> {
  const initial = nonterminalRuns(await workflows.runs(workflow));
  for (const run of initial) {
    await requestCancellation(workflows, run.id, true);
  }
  for (let poll = 0; poll < limits.maxPolls; poll += 1) {
    if (nonterminalRuns(await workflows.runs(workflow)).length === 0) return;
    await limits.sleep(limits.pollIntervalMs);
  }
  throw new Error(`${workflow} runs did not stop before the polling bound`);
}

async function cancelRun(
  workflows: NpmOperationWorkflowClient,
  runId: string,
  permitCompletedRace: boolean,
  limits: OrchestrationLimits
): Promise<void> {
  const completed = await requestCancellation(
    workflows,
    runId,
    permitCompletedRace
  );
  if (completed) return;
  for (let poll = 0; poll < limits.maxPolls; poll += 1) {
    if ((await workflows.run(runId)).status === "completed") return;
    await limits.sleep(limits.pollIntervalMs);
  }
  throw new Error(`npm operation run ${runId} did not become terminal`);
}

async function requestCancellation(
  workflows: NpmOperationWorkflowClient,
  runId: string,
  permitCompletedRace: boolean
): Promise<boolean> {
  const accepted = await workflows.cancel(runId);
  if (!accepted) {
    const run = await workflows.run(runId);
    if (!permitCompletedRace || run.status !== "completed") {
      throw new Error(`GitHub did not accept cancellation for run ${runId}`);
    }
    return true;
  }
  return false;
}

function nonterminalRuns(
  runs: readonly NpmOperationWorkflowRun[]
): readonly NpmOperationWorkflowRun[] {
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.id)) {
      throw new Error("GitHub repeated an npm workflow run");
    }
    seen.add(run.id);
  }
  return runs.filter((run) => run.status !== "completed");
}

interface OrchestrationLimits {
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs: number;
  readonly maxPolls: number;
  readonly maxOpenOperations: number;
}

function orchestrationLimits(
  dependencies: NpmOperationOrchestrationDependencies
): OrchestrationLimits {
  return Object.freeze({
    sleep: dependencies.sleep ?? ((milliseconds: number) => {
      return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    }),
    pollIntervalMs: positiveInteger(
      dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      60_000,
      "npm operation polling interval"
    ),
    maxPolls: positiveInteger(
      dependencies.maxPolls ?? DEFAULT_MAX_POLLS,
      DEFAULT_MAX_POLLS,
      "npm operation polling bound"
    ),
    maxOpenOperations: positiveInteger(
      dependencies.maxOpenOperations ?? DEFAULT_MAX_OPEN_OPERATIONS,
      DEFAULT_MAX_OPEN_OPERATIONS,
      "npm operation open lease bound"
    )
  });
}

function positiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireRequestId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(value)) {
    throw new Error("npm operation request ID is invalid");
  }
}

function requireClaimSecret(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("npm operation claim secret is invalid");
  }
}

function sameRequest(
  left: NpmOperationLeaseRequest,
  right: NpmOperationLeaseRequest
): boolean {
  return left.repository === right.repository
    && left.runId === right.runId
    && left.runAttempt === right.runAttempt
    && left.operation === right.operation
    && left.version === right.version
    && left.sourceCommit === right.sourceCommit;
}
