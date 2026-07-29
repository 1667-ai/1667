import path from "node:path";
import { canonicalJson } from "../server/canonical-json.js";
import {
  requireNpmOperationLeaseRequest,
  type NpmOperationLeaseOperation
} from "./release-npm-operation-lease-state.js";
import {
  acquireNpmOperation,
  stopActiveNpmOperations,
  type NpmOperationAuthority
} from "./release-npm-operation-orchestration.js";
import {
  recoverNpmOperation,
  type NpmOperationRecoveryRequest
} from "./release-npm-operation-recovery.js";
import {
  GitHubNpmOperationRecovery,
  writeNpmOperationReconciliation
} from "./release-npm-operation-recovery-adapter.js";
import {
  verifyNpmOperationRepositoryControls
} from "./release-npm-operation-controls.js";
import {
  inspectNpmRecoveryJournalState
} from "./release-npm-recovery-journals.js";
import {
  assertNpmProcessQuiescent
} from "./release-npm-process-journal.js";
import {
  reconcileNpmTagOperation
} from "./release-npm-operation-reconciliation.js";
import {
  PublicNpmTagRegistry
} from "./release-npm-tag-registry.js";
import {
  recordNpmQuarantineNote
} from "./release-npm-quarantine-note.js";
import {
  GitHubNpmOperationWorkflows
} from "./release-npm-operation-workflows.js";
import {
  DurableNpmOperationState,
  npmOperationRecoveryPaths,
  ProtectedMainWorkspace
} from "./release-npm-operation-workspace.js";

export async function runNpmOperationOrchestrationCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd()
): Promise<string> {
  const [command, ...rest] = args;
  const repository = requiredEnvironment(environment, "GITHUB_REPOSITORY");
  const token = requiredEnvironment(environment, "GH_TOKEN");
  const apiUrl = environment.GITHUB_API_URL;
  const options = {
    repository,
    token,
    ...(apiUrl === undefined ? {} : { apiUrl })
  };
  const workflows = new GitHubNpmOperationWorkflows(options);
  const workspace = new ProtectedMainWorkspace(workingDirectory);
  const state = new DurableNpmOperationState(environment);
  const lease = new GitHubNpmOperationRecovery(options);
  const verifyControls = async (): Promise<void> => {
    await verifyNpmOperationRepositoryControls(options);
  };
  if (command === "acquire" && rest.length === 3) {
    const [rawOperation, version, sourceCommit] = rest;
    const authority = await acquireNpmOperation(
      operation(rawOperation),
      version!,
      sourceCommit!,
      {
        repository,
        workflows,
        lease,
        state,
        workspace,
        verifyControls
      }
    );
    return authorityExports(authority);
  }
  if (command === "stop-active" && rest.length === 0) {
    await stopActiveNpmOperations({
      repository,
      workflows,
      lease,
      state,
      workspace,
      verifyControls
    });
    return `${canonicalJson({ stopped: true })}\n`;
  }
  if (command === "recover" && rest.length === 6) {
    const [runId, runAttempt, rawOperation, version, sourceCommit, stateDirectory]
      = rest;
    const leaseRequest = requireNpmOperationLeaseRequest({
      repository,
      runId: runId!,
      runAttempt: runAttempt!,
      operation: operation(rawOperation),
      version: version!,
      sourceCommit: sourceCommit!
    }, repository);
    const paths = await npmOperationRecoveryPaths(
      stateDirectory!,
      leaseRequest
    );
    const recoveryRequest: NpmOperationRecoveryRequest = Object.freeze({
      lease: leaseRequest,
      ...paths,
      quarantineNoteRecord: path.join(
        paths.stateDirectory,
        "quarantine-note.jsonl"
      ),
      claimSecret: environment.NPM_OPERATION_CLAIM_SECRET
    });
    const result = await recoverNpmOperation(recoveryRequest, {
      workflows,
      lease,
      verifyWorkspace: () => workspace.verifyProtectedMain(),
      verifyControls,
      journalState: inspectNpmRecoveryJournalState,
      assertQuiescent: assertNpmProcessQuiescent,
      reconcile: async (journalPath, request) => {
        return reconcileNpmTagOperation(
          journalPath,
          request,
          new PublicNpmTagRegistry({
            environment: {},
            authorizeWrite: async () => {
              throw new Error("npm operation recovery cannot authorize a write");
            }
          })
        );
      },
      writeReconciliation: writeNpmOperationReconciliation,
      completeQuarantine: async (request, claimSecret) => {
        await recordNpmQuarantineNote({
          repository,
          token,
          claimSecret,
          version: request.lease.version,
          journalPath: request.operationJournal,
          evidencePath: request.quarantineNoteRecord,
          lease: request.lease
        });
      }
    });
    return `${canonicalJson(result)}\n`;
  }
  throw new Error(usage());
}

function authorityExports(authority: NpmOperationAuthority): string {
  return [
    `LEASE_RUN_ID=${shellValue(authority.request.runId)}`,
    `LEASE_RUN_ATTEMPT=${shellValue(authority.request.runAttempt)}`,
    `OPERATION_STATE_DIRECTORY=${shellValue(authority.stateDirectory)}`,
    `OPERATION_JOURNAL=${shellValue(authority.operationJournal)}`,
    `PROCESS_JOURNAL=${shellValue(authority.processJournal)}`,
    `RECONCILIATION_RECORD=${shellValue(authority.reconciliationRecord)}`,
    `export NPM_OPERATION_CLAIM_SECRET=${
      shellValue(authority.claimSecret)
    }`
  ].join("\n") + "\n";
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function operation(value: string | undefined): NpmOperationLeaseOperation {
  if (value !== "promotion" && value !== "quarantine") {
    throw new Error(usage());
  }
  return value;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new Error(`npm operation orchestration requires ${name}`);
  }
  return value;
}

function usage(): string {
  return "usage: release-npm-operation-orchestration-cli.ts acquire"
    + " <promotion|quarantine> <version> <source-commit>"
    + " | release-npm-operation-orchestration-cli.ts stop-active"
    + " | release-npm-operation-orchestration-cli.ts recover"
    + " <run-id> <run-attempt> <promotion|quarantine> <version>"
    + " <source-commit> <absolute-state-directory>";
}
