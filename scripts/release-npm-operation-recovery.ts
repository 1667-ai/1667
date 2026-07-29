import type {
  NpmOperationReconciliation
} from "./release-npm-operation-reconciliation.js";
import type {
  NpmOperationLeaseRequest,
  NpmOperationLeaseTerminal,
  NpmOperationOpenState,
  NpmOperationWriterOutcome
} from "./release-npm-operation-lease-state.js";
import type {
  NpmRecoveryJournalState
} from "./release-npm-recovery-journals.js";
import type {
  NpmOperationWorkflowClient
} from "./release-npm-operation-workflows.js";
import {
  NPM_OPERATION_REVOCATION_SETTLE_MS
} from "./release-npm-operation-revocation-settlement.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLLS = 1_800;
const NONTERMINAL_RUN_STATES = new Set([
  "in_progress", "queued", "pending", "requested", "waiting"
]);

export type NpmOperationRecoveryInspection =
  | NpmOperationOpenState
  | {
      readonly request: NpmOperationLeaseRequest;
      readonly state: "pre-active-cleaned";
    };

export interface NpmOperationRecoveryLease {
  inspect(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationRecoveryInspection>;
  revoke(request: NpmOperationLeaseRequest): Promise<void>;
  assertNoWriterAfterRevocation(
    request: NpmOperationLeaseRequest
  ): Promise<void>;
  writerOutcome(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationWriterOutcome | null>;
  complete(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void>;
  abandon(request: NpmOperationLeaseRequest): Promise<void>;
  cleanupOpen(request: NpmOperationLeaseRequest): Promise<void>;
  terminalOutcome(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationLeaseTerminal | null>;
}

export interface NpmOperationRecoveryRequest {
  readonly lease: NpmOperationLeaseRequest;
  readonly operationJournal: string;
  readonly processJournal: string;
  readonly reconciliationRecord: string;
  readonly quarantineNoteRecord: string;
  readonly claimSecret?: string;
}

export type NpmOperationRecoveryResult =
  | {
      readonly branch: "terminal";
      readonly outcome: NpmOperationLeaseTerminal;
    }
  | {
      readonly branch: "pre-active";
      readonly outcome: "cleaned";
    }
  | {
      readonly branch: "pre-writer";
      readonly journalState: "absent" | "process-only";
      readonly outcome: "abandoned";
    }
  | {
      readonly branch: "journals";
      readonly verdict: NpmOperationReconciliation["verdict"];
      readonly writerOutcome: NpmOperationWriterOutcome | null;
      readonly outcome: "complete" | "abandoned";
    };

export interface NpmOperationRecoveryDependencies {
  readonly workflows: NpmOperationWorkflowClient;
  readonly lease: NpmOperationRecoveryLease;
  readonly verifyWorkspace: () => Promise<void>;
  readonly verifyControls: () => Promise<void>;
  readonly journalState: (
    operationJournal: string,
    processJournal: string,
    request: NpmOperationLeaseRequest
  ) => NpmRecoveryJournalState;
  readonly assertQuiescent: (
    processJournal: string,
    request: NpmOperationLeaseRequest
  ) => void;
  readonly reconcile: (
    operationJournal: string,
    request: NpmOperationLeaseRequest
  ) => Promise<NpmOperationReconciliation>;
  readonly writeReconciliation: (
    path: string,
    value: NpmOperationReconciliation
  ) => Promise<void>;
  readonly completeQuarantine: (
    request: NpmOperationRecoveryRequest,
    claimSecret: string
  ) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
}

export async function recoverNpmOperation(
  request: NpmOperationRecoveryRequest,
  dependencies: NpmOperationRecoveryDependencies
): Promise<NpmOperationRecoveryResult> {
  const limits = recoveryLimits(dependencies);
  await dependencies.verifyWorkspace();
  await dependencies.verifyControls();
  await dependencies.lease.inspect(request.lease);
  await stopHolder(request.lease.runId, dependencies.workflows, limits);
  const inspection = await dependencies.lease.inspect(request.lease);
  if (inspection.state === "terminal") {
    const outcome = await requireTerminalOutcome(
      dependencies.lease,
      request.lease
    );
    await dependencies.lease.cleanupOpen(request.lease);
    return Object.freeze({ branch: "terminal", outcome });
  }
  if (inspection.state === "pre-active"
    || inspection.state === "pre-active-cleaned") {
    await dependencies.lease.cleanupOpen(request.lease);
    return Object.freeze({ branch: "pre-active", outcome: "cleaned" });
  }
  await dependencies.lease.revoke(request.lease);
  const initialJournalState = dependencies.journalState(
    request.operationJournal,
    request.processJournal,
    request.lease
  );
  if (initialJournalState !== "present") {
    await provePreWriterState(
      request,
      initialJournalState,
      dependencies,
      limits
    );
    await dependencies.lease.abandon(request.lease);
    return Object.freeze({
      branch: "pre-writer",
      journalState: initialJournalState,
      outcome: "abandoned"
    });
  }
  dependencies.assertQuiescent(request.processJournal, request.lease);
  await limits.sleep(NPM_OPERATION_REVOCATION_SETTLE_MS);
  dependencies.assertQuiescent(request.processJournal, request.lease);
  const reconciliation = await dependencies.reconcile(
    request.operationJournal,
    request.lease
  );
  requireVerdict(reconciliation.verdict);
  await dependencies.writeReconciliation(
    request.reconciliationRecord,
    reconciliation
  );
  const writerOutcome = await dependencies.lease.writerOutcome(request.lease);
  requireWriterOutcome(writerOutcome);
  const claimSecret = availableClaimSecret(request.claimSecret);
  if (reconciliation.verdict === "complete"
    && writerOutcome === "success"
    && claimSecret !== null) {
    if (request.lease.operation === "promotion") {
      await dependencies.lease.complete(request.lease, claimSecret);
    } else {
      await dependencies.completeQuarantine(request, claimSecret);
    }
    return Object.freeze({
      branch: "journals",
      verdict: reconciliation.verdict,
      writerOutcome,
      outcome: "complete"
    });
  }
  await dependencies.lease.abandon(request.lease);
  return Object.freeze({
    branch: "journals",
    verdict: reconciliation.verdict,
    writerOutcome,
    outcome: "abandoned"
  });
}

async function provePreWriterState(
  request: NpmOperationRecoveryRequest,
  expected: "absent" | "process-only",
  dependencies: NpmOperationRecoveryDependencies,
  limits: RecoveryLimits
): Promise<void> {
  await dependencies.lease.assertNoWriterAfterRevocation(request.lease);
  requireJournalState(
    dependencies.journalState(
      request.operationJournal,
      request.processJournal,
      request.lease
    ),
    expected
  );
  if (expected === "process-only") {
    dependencies.assertQuiescent(request.processJournal, request.lease);
  }
  await limits.sleep(NPM_OPERATION_REVOCATION_SETTLE_MS);
  await dependencies.lease.assertNoWriterAfterRevocation(request.lease);
  requireJournalState(
    dependencies.journalState(
      request.operationJournal,
      request.processJournal,
      request.lease
    ),
    expected
  );
  if (expected === "process-only") {
    dependencies.assertQuiescent(request.processJournal, request.lease);
  }
}

async function stopHolder(
  runId: string,
  workflows: NpmOperationWorkflowClient,
  limits: RecoveryLimits
): Promise<void> {
  const initial = await workflows.run(runId);
  if (initial.status === "completed") return;
  if (!NONTERMINAL_RUN_STATES.has(initial.status)) {
    throw new Error("npm operation holder has an unsafe workflow state");
  }
  if (!await workflows.cancel(runId)) {
    if ((await workflows.run(runId)).status === "completed") return;
    throw new Error("GitHub did not accept npm operation holder cancellation");
  }
  for (let poll = 0; poll < limits.maxPolls; poll += 1) {
    const current = await workflows.run(runId);
    if (current.status === "completed") return;
    if (!NONTERMINAL_RUN_STATES.has(current.status)) {
      throw new Error("npm operation holder entered an unsafe workflow state");
    }
    await limits.sleep(limits.pollIntervalMs);
  }
  throw new Error("npm operation holder did not stop before the polling bound");
}

async function requireTerminalOutcome(
  lease: NpmOperationRecoveryLease,
  request: NpmOperationLeaseRequest
): Promise<NpmOperationLeaseTerminal> {
  const outcome = await lease.terminalOutcome(request);
  if (outcome === null) {
    throw new Error("npm operation terminal marker has no valid outcome");
  }
  return outcome;
}

function requireJournalState(
  actual: NpmRecoveryJournalState,
  expected: "absent" | "process-only"
): void {
  if (actual !== expected) {
    throw new Error("npm operation journals changed during pre-writer recovery");
  }
}

function requireVerdict(
  value: NpmOperationReconciliation["verdict"]
): void {
  if (value !== "complete" && value !== "retry-required"
    && value !== "safe-to-abandon") {
    throw new Error("npm operation reconciliation verdict is invalid");
  }
}

function requireWriterOutcome(
  value: NpmOperationWriterOutcome | null
): void {
  if (value !== null && value !== "success" && value !== "failed") {
    throw new Error("npm operation writer outcome is invalid");
  }
}

function availableClaimSecret(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("npm operation claim secret is invalid");
  }
  return value;
}

interface RecoveryLimits {
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs: number;
  readonly maxPolls: number;
}

function recoveryLimits(
  dependencies: NpmOperationRecoveryDependencies
): RecoveryLimits {
  return Object.freeze({
    sleep: dependencies.sleep ?? ((milliseconds: number) => {
      return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    }),
    pollIntervalMs: positiveInteger(
      dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      60_000,
      "npm operation recovery polling interval"
    ),
    maxPolls: positiveInteger(
      dependencies.maxPolls ?? DEFAULT_MAX_POLLS,
      DEFAULT_MAX_POLLS,
      "npm operation recovery polling bound"
    )
  });
}

function positiveInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
