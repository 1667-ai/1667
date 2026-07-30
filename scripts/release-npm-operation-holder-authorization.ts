import {
  GitHubRefStore,
  type GitHubRef
} from "./release-github-ref-store.js";
import type {
  GitHubConcurrencyAcquisition,
  GitHubConcurrencyMember
} from "./release-github-concurrency.js";
import {
  GitHubWorkflowClient,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun
} from "./release-github-workflow-client.js";
import {
  type NpmOperationLeaseRequest
} from "./release-npm-operation-lease-state.js";

const SHA = /^[0-9a-f]{40}$/u;
export const NPM_OPERATION_CONCURRENCY_GROUP = "release-npm";

export async function authorizeNpmOperationHolder(
  store: GitHubRefStore,
  workflow: GitHubWorkflowClient,
  request: NpmOperationLeaseRequest,
  knownAcquisition?: GitHubConcurrencyAcquisition
): Promise<GitHubConcurrencyAcquisition> {
  const acquisition = knownAcquisition
    ?? await workflow.concurrencyAcquisition(NPM_OPERATION_CONCURRENCY_GROUP);
  await authorizeNpmOperationHolderRun(store, workflow, request);
  const job = requireNpmOperationHolderJob(
    await workflow.workflowJobs(request.runId),
    request
  );
  return requireNpmOperationConcurrencyHolder(
    acquisition,
    await workflow.concurrencyMembers(NPM_OPERATION_CONCURRENCY_GROUP),
    job,
    request
  );
}

export async function authorizeNpmOperationHolderRun(
  store: GitHubRefStore,
  workflow: GitHubWorkflowClient,
  request: NpmOperationLeaseRequest
): Promise<void> {
  const main = (await store.matchingRefs("heads/main"))
    .filter((ref) => ref.ref === "refs/heads/main");
  if (main.length !== 1) {
    throw new Error("npm operation lease main branch ref is not exact");
  }
  requireNpmOperationHolderRun(
    await workflow.workflowRun(request.runId),
    request,
    main[0]!
  );
}

export function requireNpmOperationHolderRun(
  run: GitHubWorkflowRun,
  request: NpmOperationLeaseRequest,
  mainRef: GitHubRef
): void {
  if (!isNpmOperationHolderRun(run, request)
    || run.status !== "in_progress"
    || run.conclusion !== null
    || mainRef.ref !== "refs/heads/main"
    || mainRef.object.type !== "commit"
    || mainRef.object.sha !== run.head_sha) {
    throw new Error("npm operation lease holder workflow is not authorized");
  }
}

export function requireNpmOperationTerminalHolderRun(
  run: GitHubWorkflowRun,
  request: NpmOperationLeaseRequest
): void {
  if (!isNpmOperationHolderRun(run, request)
    || run.status !== "completed"
    || typeof run.conclusion !== "string"
    || run.conclusion === "") {
    throw new Error("npm operation lease holder workflow is not terminal");
  }
}

export function requireNpmOperationHolderJob(
  jobs: readonly GitHubWorkflowJob[],
  request: NpmOperationLeaseRequest
): GitHubWorkflowJob {
  const matching = jobs.filter((job) => job.name === "hold");
  if (matching.length !== 1
    || matching[0]!.run_id !== Number(request.runId)
    || matching[0]!.status !== "in_progress"
    || matching[0]!.conclusion !== null) {
    throw new Error("npm operation lease hold job is not authorized");
  }
  return matching[0]!;
}

export function requireNpmOperationConcurrencyHolder(
  acquisition: GitHubConcurrencyAcquisition,
  members: readonly GitHubConcurrencyMember[],
  job: GitHubWorkflowJob,
  request: NpmOperationLeaseRequest
): GitHubConcurrencyAcquisition {
  if (acquisition.groupName !== NPM_OPERATION_CONCURRENCY_GROUP
    || members.length !== 1
    || members[0]!.runId !== Number(request.runId)
    || members[0]!.jobId !== job.id
    || members[0]!.jobName !== "hold"
    || members[0]!.status !== "in_progress") {
    throw new Error("npm operation lease concurrency holder is not authorized");
  }
  return acquisition;
}

export function requireNpmOperationDispatcherPermission(permission: string): void {
  if (permission !== "admin") {
    throw new Error("npm operation lease dispatcher is not an administrator");
  }
}

function isNpmOperationHolderRun(
  run: GitHubWorkflowRun,
  request: NpmOperationLeaseRequest
): boolean {
  const workflowPath = ".github/workflows/release-npm-operation.yml";
  const title = `npm ${request.operation} v${request.version} (`;
  const source = `; source ${request.sourceCommit})`;
  const requestId = run.display_title.startsWith(title)
    && run.display_title.endsWith(source)
    ? run.display_title.slice(title.length, -source.length)
    : "";
  return run.id === Number(request.runId)
    && run.run_attempt === Number(request.runAttempt)
    && run.repository.full_name === request.repository
    && (run.path === workflowPath || run.path === `${workflowPath}@main`)
    && run.name === run.display_title
    && run.event === "workflow_dispatch"
    && run.head_branch === "main"
    && SHA.test(run.head_sha)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(requestId);
}
