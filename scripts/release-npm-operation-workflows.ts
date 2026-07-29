import { canonicalJson } from "../server/canonical-json.js";
import {
  GitHubWorkflowClient,
  type GitHubWorkflowJob,
  type GitHubWorkflowRun
} from "./release-github-workflow-client.js";
import { GitHubHttpTransport } from "./release-github-http.js";

const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_RUN_PAGES = 100;
const RUNS_PER_PAGE = 100;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_ID = /^[1-9]\d{0,15}$/u;

export type NpmOperationWorkflow =
  | "release-npm.yml"
  | "release-npm-operation.yml";

export interface NpmOperationWorkflowRun {
  readonly id: string;
  readonly attempt: string;
  readonly displayTitle: string;
  readonly status: string;
}

export interface NpmOperationWorkflowClient {
  dispatchHolder(input: {
    readonly operation: "promotion" | "quarantine";
    readonly version: string;
    readonly sourceCommit: string;
    readonly requestId: string;
  }): Promise<void>;
  runs(
    workflow: NpmOperationWorkflow
  ): Promise<readonly NpmOperationWorkflowRun[]>;
  run(runId: string): Promise<GitHubWorkflowRun>;
  jobs(runId: string): Promise<readonly GitHubWorkflowJob[]>;
  cancel(runId: string): Promise<boolean>;
}

export interface GitHubNpmOperationWorkflowOptions {
  readonly repository: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestSignal?: () => AbortSignal | undefined;
}

export class GitHubNpmOperationWorkflows
implements NpmOperationWorkflowClient {
  readonly #repository: string;
  readonly #http: GitHubHttpTransport;
  readonly #workflow: GitHubWorkflowClient;

  constructor(options: GitHubNpmOperationWorkflowOptions) {
    if (!REPOSITORY.test(options.repository)) {
      throw new Error("npm operation workflow repository is invalid");
    }
    if (options.token === "") {
      throw new Error("npm operation workflow token is required");
    }
    this.#repository = options.repository;
    const http = new GitHubHttpTransport({
      token: options.token,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      requestSignal: options.requestSignal,
      maxResponseBytes: MAX_API_BYTES,
      userAgent: "1667-release-npm-operation-workflows"
    });
    this.#http = http;
    this.#workflow = new GitHubWorkflowClient(this.#repository, http);
  }

  async dispatchHolder(input: {
    readonly operation: "promotion" | "quarantine";
    readonly version: string;
    readonly sourceCommit: string;
    readonly requestId: string;
  }): Promise<void> {
    const response = await this.#request(
      `repos/${this.#repository}/actions/workflows/`
        + "release-npm-operation.yml/dispatches",
      {
        body: canonicalJson({
          ref: "main",
          inputs: {
            operation: input.operation,
            request_id: input.requestId,
            source_commit: input.sourceCommit,
            version: input.version
          }
        }),
        method: "POST"
      }
    );
    if (response.status !== 204) {
      throw new Error(
        `GitHub returned ${response.status} while dispatching the npm operation holder`
      );
    }
  }

  async runs(
    workflow: NpmOperationWorkflow
  ): Promise<readonly NpmOperationWorkflowRun[]> {
    const runs: NpmOperationWorkflowRun[] = [];
    for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
      const response = await this.#request(
        `repos/${this.#repository}/actions/workflows/${workflow}/runs`
          + `?per_page=${RUNS_PER_PAGE}&page=${page}`,
        { method: "GET" }
      );
      if (response.status !== 200) {
        throw new Error(
          `GitHub returned ${response.status} while listing npm workflow runs`
        );
      }
      const value = object(
        await this.#http.readJson(response, "npm workflow runs"),
        "npm workflow runs"
      );
      if (!Array.isArray(value.workflow_runs)) {
        throw new Error("GitHub returned malformed npm workflow runs");
      }
      const pageRuns = value.workflow_runs.map(workflowRun);
      runs.push(...pageRuns);
      if (pageRuns.length < RUNS_PER_PAGE) return Object.freeze(runs);
    }
    throw new Error("npm workflow runs exceed the pagination bound");
  }

  async run(runId: string): Promise<GitHubWorkflowRun> {
    requireRunId(runId);
    return this.#workflow.workflowRun(runId);
  }

  async jobs(runId: string): Promise<readonly GitHubWorkflowJob[]> {
    requireRunId(runId);
    return this.#workflow.workflowJobs(runId);
  }

  async cancel(runId: string): Promise<boolean> {
    requireRunId(runId);
    const response = await this.#request(
      `repos/${this.#repository}/actions/runs/${runId}/cancel`,
      { method: "POST" }
    );
    return response.status === 202;
  }

  async #request(pathname: string, init: RequestInit): Promise<Response> {
    return this.#http.request(pathname, {
      body: typeof init.body === "string" ? init.body : undefined,
      method: requestMethod(init.method)
    }, "GitHub npm workflow");
  }
}

function workflowRun(value: unknown): NpmOperationWorkflowRun {
  const run = object(value, "npm workflow run");
  if (!Number.isSafeInteger(run.id) || Number(run.id) <= 0
    || !Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) <= 0
    || typeof run.display_title !== "string"
    || Buffer.byteLength(run.display_title) > 512
    || typeof run.status !== "string" || run.status === "") {
    throw new Error("GitHub returned a malformed npm workflow run");
  }
  return Object.freeze({
    id: String(run.id),
    attempt: String(run.run_attempt),
    displayTitle: run.display_title,
    status: run.status
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireRunId(value: string): void {
  if (!RUN_ID.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("npm operation workflow run ID is invalid");
  }
}

function requestMethod(
  value: string | undefined
): "GET" | "POST" {
  if (value === "GET" || value === "POST") return value;
  throw new Error("npm operation workflow request method is invalid");
}
