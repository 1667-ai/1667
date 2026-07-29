import type { NpmOperationLeaseRequest } from
  "../scripts/release-npm-operation-lease.js";
import type {
  GitHubRef
} from "../scripts/release-github-ref-store.js";
import type {
  GitHubWorkflowRun
} from "../scripts/release-github-workflow-client.js";

export const HOLDER_COMMIT = "e".repeat(40);

export function workflowRun(
  request: NpmOperationLeaseRequest
): GitHubWorkflowRun {
  return Object.freeze({
    id: Number(request.runId),
    run_attempt: Number(request.runAttempt),
    name: "Hold npm operation",
    path: ".github/workflows/release-npm-operation.yml",
    display_title: `npm ${request.operation} v${request.version}`
      + " (123e4567-e89b-42d3-a456-426614174000;"
      + ` source ${request.sourceCommit})`,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    head_branch: "main",
    head_sha: HOLDER_COMMIT,
    repository: Object.freeze({ full_name: request.repository })
  });
}

export function freezeRef(ref: string, type: string, sha: string): GitHubRef {
  return Object.freeze({ ref, object: Object.freeze({ type, sha }) });
}

export function jsonResponse(
  value: unknown,
  status: number,
  date?: string
): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
      ...(date === undefined ? {} : { date })
    },
    status
  });
}
