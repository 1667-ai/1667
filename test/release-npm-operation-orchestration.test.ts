import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireNpmOperation,
  stopActiveNpmOperations,
  type NpmOperationLeaseOrchestrator
} from "../scripts/release-npm-operation-orchestration.js";
import {
  recoverNpmOperation,
  type NpmOperationRecoveryLease,
  type NpmOperationRecoveryRequest
} from "../scripts/release-npm-operation-recovery.js";
import type {
  NpmOperationReconciliation
} from "../scripts/release-npm-operation-reconciliation.js";
import type {
  NpmOperationLeaseRequest,
  NpmOperationOpenState
} from "../scripts/release-npm-operation-lease-state.js";
import type {
  NpmOperationWorkflow,
  NpmOperationWorkflowClient,
  NpmOperationWorkflowRun
} from "../scripts/release-npm-operation-workflows.js";

const REPOSITORY = "1667-ai/1667";
const SOURCE = "a".repeat(40);
const CLAIM = "b".repeat(64);
const REQUEST: NpmOperationLeaseRequest = Object.freeze({
  repository: REPOSITORY,
  runId: "123",
  runAttempt: "1",
  operation: "promotion",
  version: "1.2.3",
  sourceCommit: SOURCE
});
const TITLE = "npm promotion v1.2.3"
  + " (123e4567-e89b-42d3-a456-426614174000;"
  + ` source ${SOURCE})`;

test("acquire dispatches, waits for the exact hold job, and exports authority",
  async () => {
    const events: string[] = [];
    const workflows = new FakeWorkflows(events);
    workflows.operationRuns = [summary("123", "in_progress", TITLE)];
    const lease = new FakeLease(events);
    const authority = await acquireNpmOperation(
      "promotion",
      "1.2.3",
      SOURCE,
      orchestrationDependencies(events, workflows, lease)
    );

    assert.equal(authority.claimSecret, CLAIM);
    assert.equal(authority.request.runId, "123");
    assert.deepEqual(events, [
      "workspace:any", "controls", "state-root", "dispatch",
      "runs:release-npm-operation.yml", "jobs:123", "claim:123",
      "run:123", `workspace:${"e".repeat(40)}`, "state-paths"
    ]);
  });

test("acquire rejects an ambiguous holder before it creates authority", async () => {
  const events: string[] = [];
  const workflows = new FakeWorkflows(events);
  workflows.operationRuns = [
    summary("123", "in_progress", TITLE),
    summary("124", "in_progress", TITLE)
  ];
  await assert.rejects(
    acquireNpmOperation(
      "promotion",
      "1.2.3",
      SOURCE,
      orchestrationDependencies(events, workflows, new FakeLease(events))
    ),
    /More than one/u
  );
  assert.doesNotMatch(events.join(","), /claim/u);
});

test("acquire rejects a holder that becomes terminal after the claim", async () => {
  const events: string[] = [];
  const workflows = new FakeWorkflows(events);
  workflows.operationRuns = [summary("123", "in_progress", TITLE)];
  const lease = new FakeLease(events);
  lease.claim = async (request) => {
    events.push(`claim:${request.runId}`);
    workflows.status.set(request.runId, "completed");
  };

  await assert.rejects(
    acquireNpmOperation(
      "promotion",
      "1.2.3",
      SOURCE,
      orchestrationDependencies(events, workflows, lease)
    ),
    /holder workflow is not authorized/u
  );
  assert.doesNotMatch(events.join(","), /state-paths/u);
});

test("stop-active cancels both paginated workflow sets before revocation",
  async () => {
    const events: string[] = [];
    const workflows = new FakeWorkflows(events);
    workflows.publicationRuns = [summary("50", "in_progress", "publication")];
    workflows.operationRuns = [summary("123", "queued", TITLE)];
    const lease = new FakeLease(events);
    lease.open = [{ request: REQUEST, state: "active" }, null];

    await stopActiveNpmOperations(
      orchestrationDependencies(events, workflows, lease)
    );

    assert.ok(events.indexOf("cancel:50") < events.indexOf("cancel:123"));
    assert.ok(events.indexOf("cancel:123") < events.indexOf("revoke:123"));
    assert.ok(events.indexOf("revoke:123") < events.indexOf("sleep:600000"));
    assert.ok(events.indexOf("sleep:600000") < events.indexOf("abandon:123"));
    assert.equal(events.at(-1), "assert-clear");
  });

test("stop-active does not accept a revocation race for another lease", async () => {
  const events: string[] = [];
  const workflows = new FakeWorkflows(events);
  const lease = new FakeLease(events);
  lease.open = [
    { request: REQUEST, state: "active" },
    { request: { ...REQUEST, runId: "999" }, state: "terminal" }
  ];
  lease.revokeError = new Error("revocation failed");
  await assert.rejects(
    stopActiveNpmOperations(
      orchestrationDependencies(events, workflows, lease)
    ),
    /revocation failed/u
  );
  assert.doesNotMatch(events.join(","), /abandon/u);
});

test("journal recovery cancels before revocation and completes with authority",
  async () => {
    const events: string[] = [];
    const workflows = new FakeWorkflows(events);
    workflows.status.set("123", "in_progress");
    const lease = new FakeLease(events);
    lease.inspections = [
      { request: REQUEST, state: "active" },
      { request: REQUEST, state: "active" }
    ];
    lease.outcome = "success";

    const result = await recoverNpmOperation(recoveryRequest(), {
      ...recoveryDependencies(events, workflows, lease),
      journalState: () => "present",
      reconcile: async () => {
        events.push("reconcile");
        return reconciliation("complete");
      }
    });

    assert.deepEqual(result, {
      branch: "journals",
      verdict: "complete",
      writerOutcome: "success",
      outcome: "complete"
    });
    assert.ok(events.indexOf("cancel:123") < events.indexOf("revoke:123"));
    assert.ok(events.indexOf("revoke:123") < events.indexOf("quiescent"));
    assert.ok(events.indexOf("quiescent") < events.indexOf("sleep:600000"));
    assert.ok(events.indexOf("write-reconciliation")
      < events.indexOf("complete:123"));
  });

test("pre-writer recovery repeats every proof after settlement", async () => {
  const events: string[] = [];
  const workflows = new FakeWorkflows(events);
  workflows.status.set("123", "completed");
  const lease = new FakeLease(events);
  lease.inspections = [
    { request: REQUEST, state: "active" },
    { request: REQUEST, state: "active" }
  ];
  let stateReads = 0;

  const result = await recoverNpmOperation(recoveryRequest(), {
    ...recoveryDependencies(events, workflows, lease),
    journalState: () => {
      stateReads += 1;
      events.push("journal-state");
      return "process-only";
    }
  });

  assert.deepEqual(result, {
    branch: "pre-writer",
    journalState: "process-only",
    outcome: "abandoned"
  });
  assert.equal(stateReads, 3);
  assert.equal(events.filter((event) => event === "no-writer").length, 2);
  assert.equal(events.filter((event) => event === "quiescent").length, 2);
  assert.ok(events.lastIndexOf("quiescent") < events.indexOf("abandon:123"));
});

test("pre-writer recovery fails closed when a journal appears", async () => {
  const events: string[] = [];
  const workflows = new FakeWorkflows(events);
  workflows.status.set("123", "completed");
  const lease = new FakeLease(events);
  lease.inspections = [
    { request: REQUEST, state: "active" },
    { request: REQUEST, state: "active" }
  ];
  const states: Array<"absent" | "present"> = [
    "absent", "absent", "present"
  ];
  await assert.rejects(
    recoverNpmOperation(recoveryRequest(), {
      ...recoveryDependencies(events, workflows, lease),
      journalState: () => states.shift() ?? "present"
    }),
    /journals changed/u
  );
  assert.doesNotMatch(events.join(","), /abandon/u);
});

test("recovery cleanup converges after a terminal cleanup crash", async () => {
  const events: string[] = [];
  const workflows = new FakeWorkflows(events);
  workflows.status.set("123", "completed");
  const lease = new FakeLease(events);
  lease.inspections = [
    { request: REQUEST, state: "terminal" },
    { request: REQUEST, state: "terminal" }
  ];
  lease.terminal = "abandoned";
  const result = await recoverNpmOperation(
    recoveryRequest(),
    recoveryDependencies(events, workflows, lease)
  );
  assert.deepEqual(result, { branch: "terminal", outcome: "abandoned" });
  assert.equal(events.at(-1), "cleanup:123");
});

test("recovery accepts a cancellation race only after the holder is terminal",
  async () => {
    const events: string[] = [];
    const workflows = new FakeWorkflows(events);
    workflows.status.set("123", "in_progress");
    workflows.cancel = async (runId) => {
      events.push(`cancel:${runId}`);
      workflows.status.set(runId, "completed");
      return false;
    };
    const lease = new FakeLease(events);
    lease.inspections = [
      { request: REQUEST, state: "active" },
      { request: REQUEST, state: "pre-active" }
    ];

    assert.deepEqual(
      await recoverNpmOperation(
        recoveryRequest(),
        recoveryDependencies(events, workflows, lease)
      ),
      { branch: "pre-active", outcome: "cleaned" }
    );
    assert.ok(events.indexOf("cancel:123") < events.indexOf("cleanup:123"));
  });

class FakeWorkflows implements NpmOperationWorkflowClient {
  publicationRuns: NpmOperationWorkflowRun[] = [];
  operationRuns: NpmOperationWorkflowRun[] = [];
  readonly status = new Map<string, string>();
  readonly #events: string[];

  constructor(events: string[]) {
    this.#events = events;
  }

  async dispatchHolder(): Promise<void> {
    this.#events.push("dispatch");
  }

  async runs(workflow: NpmOperationWorkflow) {
    this.#events.push(`runs:${workflow}`);
    const runs = workflow === "release-npm.yml"
      ? this.publicationRuns
      : this.operationRuns;
    return runs.map((run) => ({
      ...run,
      status: this.status.get(run.id) ?? run.status
    }));
  }

  async run(runId: string) {
    this.#events.push(`run:${runId}`);
    return {
      id: Number(runId),
      run_attempt: 1,
      name: "Hold npm operation",
      path: ".github/workflows/release-npm-operation.yml",
      display_title: TITLE,
      event: "workflow_dispatch",
      status: this.status.get(runId) ?? "in_progress",
      conclusion: null,
      head_branch: "main",
      head_sha: "e".repeat(40),
      repository: { full_name: REPOSITORY }
    };
  }

  async jobs(runId: string) {
    this.#events.push(`jobs:${runId}`);
    return [{
      id: 1,
      run_id: Number(runId),
      name: "hold",
      status: "in_progress",
      conclusion: null
    }];
  }

  async cancel(runId: string): Promise<boolean> {
    this.#events.push(`cancel:${runId}`);
    if (this.status.get(runId) === "completed") return false;
    this.status.set(runId, "completed");
    return true;
  }
}

class FakeLease
implements NpmOperationLeaseOrchestrator, NpmOperationRecoveryLease {
  open: Array<NpmOperationOpenState | null> = [null];
  inspections: Array<
    Awaited<ReturnType<NpmOperationRecoveryLease["inspect"]>>
  > = [];
  outcome: "success" | "failed" | null = null;
  terminal: "complete" | "failed" | "abandoned" | null = null;
  revokeError: Error | null = null;
  readonly #events: string[];

  constructor(events: string[]) {
    this.#events = events;
  }

  async claim(request: NpmOperationLeaseRequest): Promise<void> {
    this.#events.push(`claim:${request.runId}`);
  }

  async openState(): Promise<NpmOperationOpenState | null> {
    this.#events.push("open-state");
    return this.open.shift() ?? null;
  }

  async inspect() {
    this.#events.push("inspect");
    return this.inspections.shift()
      ?? { request: REQUEST, state: "pre-active-cleaned" as const };
  }

  async revoke(request: NpmOperationLeaseRequest): Promise<void> {
    this.#events.push(`revoke:${request.runId}`);
    if (this.revokeError !== null) throw this.revokeError;
  }

  async abandon(request: NpmOperationLeaseRequest): Promise<void> {
    this.#events.push(`abandon:${request.runId}`);
  }

  async cleanupOpen(request: NpmOperationLeaseRequest): Promise<void> {
    this.#events.push(`cleanup:${request.runId}`);
  }

  async assertNoActiveWithVerifiedControls(): Promise<void> {
    this.#events.push("assert-clear");
  }

  async assertNoWriterAfterRevocation(): Promise<void> {
    this.#events.push("no-writer");
  }

  async writerOutcome() {
    this.#events.push("writer-outcome");
    return this.outcome;
  }

  async complete(request: NpmOperationLeaseRequest): Promise<void> {
    this.#events.push(`complete:${request.runId}`);
  }

  async terminalOutcome() {
    this.#events.push("terminal-outcome");
    return this.terminal;
  }
}

function orchestrationDependencies(
  events: string[],
  workflows: FakeWorkflows,
  lease: FakeLease
) {
  return {
    repository: REPOSITORY,
    workflows,
    lease,
    state: {
      async prepareRoot() {
        events.push("state-root");
      },
      async paths() {
        events.push("state-paths");
        return {
          stateDirectory: "/state/run",
          operationJournal: "/state/run/journal.jsonl",
          processJournal: "/state/run/processes.jsonl",
          reconciliationRecord: "/state/run/reconciliation.json"
        };
      }
    },
    workspace: {
      async verifyProtectedMain(expected?: string) {
        events.push(`workspace:${expected ?? "any"}`);
      }
    },
    async verifyControls() {
      events.push("controls");
    },
    async sleep(milliseconds: number) {
      events.push(`sleep:${milliseconds}`);
    },
    pollIntervalMs: 1,
    maxPolls: 3,
    requestId: () => "123e4567-e89b-42d3-a456-426614174000",
    claimSecret: () => CLAIM
  };
}

function recoveryDependencies(
  events: string[],
  workflows: FakeWorkflows,
  lease: FakeLease
) {
  return {
    workflows,
    lease,
    async verifyWorkspace() {
      events.push("workspace");
    },
    async verifyControls() {
      events.push("controls");
    },
    journalState: () => "absent" as const,
    assertQuiescent() {
      events.push("quiescent");
    },
    async reconcile() {
      events.push("reconcile");
      return reconciliation("safe-to-abandon");
    },
    async writeReconciliation() {
      events.push("write-reconciliation");
    },
    async completeQuarantine() {
      events.push("complete-quarantine");
    },
    async sleep(milliseconds: number) {
      events.push(`sleep:${milliseconds}`);
    },
    pollIntervalMs: 1,
    maxPolls: 3
  };
}

function recoveryRequest(): NpmOperationRecoveryRequest {
  return {
    lease: REQUEST,
    operationJournal: "/state/journal.jsonl",
    processJournal: "/state/processes.jsonl",
    reconciliationRecord: "/state/reconciliation.json",
    quarantineNoteRecord: "/state/quarantine-note.jsonl",
    claimSecret: CLAIM
  };
}

function summary(
  id: string,
  status: string,
  displayTitle: string
): NpmOperationWorkflowRun {
  return { id, attempt: "1", displayTitle, status };
}

function reconciliation(
  verdict: "complete" | "retry-required" | "safe-to-abandon"
): NpmOperationReconciliation {
  return {
    schemaVersion: 1,
    registry: "https://registry.npmjs.org/",
    identity: REQUEST,
    parameters: {
      operation: "promotion",
      promotion: { destination: "latest", stableAcknowledged: false }
    },
    packageOrder: [],
    observed: [],
    journal: { records: 1, terminal: "complete", writeAttempts: 0 },
    verdict
  };
}
