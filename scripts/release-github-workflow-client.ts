import {
  parseConcurrencyMembers,
  requireConcurrencyGroup,
  type GitHubConcurrencyAcquisition,
  type GitHubConcurrencyMember
} from "./release-github-concurrency.js";
import {
  readGitHubConcurrencyAcquisition
} from "./release-github-concurrency-client.js";
import { GitHubHttpTransport } from "./release-github-http.js";

const MAX_JOB_PAGES = 10;
const JOBS_PER_PAGE = 100;
const CONCURRENCY_API_VERSION = "2026-03-10";
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

export interface GitHubWorkflowRun {
  readonly id: number;
  readonly run_attempt: number;
  readonly name: string;
  readonly path: string;
  readonly display_title: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: unknown;
  readonly head_branch: unknown;
  readonly head_sha: string;
  readonly repository: { readonly full_name: string };
}

export interface GitHubWorkflowJob {
  readonly id: number;
  readonly run_id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: unknown;
}

export class GitHubWorkflowClient {
  readonly #repository: string;
  readonly #http: GitHubHttpTransport;

  constructor(repository: string, http: GitHubHttpTransport) {
    this.#repository = repository;
    this.#http = http;
  }

  async workflowRun(runId: string): Promise<GitHubWorkflowRun> {
    requireRunId(runId);
    const response = await this.#get(
      `repos/${this.#repository}/actions/runs/${runId}`
    );
    if (response.status !== 200) {
      throw new Error(
        `GitHub ref store returned ${response.status} while reading workflow run`
      );
    }
    return workflowRun(
      await this.#http.readJson(response, "GitHub ref store workflow run")
    );
  }

  async workflowJobs(runId: string): Promise<readonly GitHubWorkflowJob[]> {
    requireRunId(runId);
    const jobs: GitHubWorkflowJob[] = [];
    for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
      const response = await this.#get(
        `repos/${this.#repository}/actions/runs/${runId}/jobs`
          + `?filter=latest&per_page=${JOBS_PER_PAGE}&page=${page}`
      );
      if (response.status !== 200) {
        throw new Error(
          `GitHub ref store returned ${response.status} while reading workflow jobs`
        );
      }
      const value = object(
        await this.#http.readJson(response, "GitHub ref store workflow jobs"),
        "GitHub ref store workflow jobs"
      );
      if (!Array.isArray(value.jobs)) {
        throw new Error("GitHub ref store workflow jobs must be an array");
      }
      jobs.push(...value.jobs.map(workflowJob));
      if (value.jobs.length < JOBS_PER_PAGE) return Object.freeze(jobs);
    }
    throw new Error("GitHub ref store workflow jobs exceed the pagination bound");
  }

  async concurrencyAcquisition(
    groupName: string
  ): Promise<GitHubConcurrencyAcquisition> {
    return readGitHubConcurrencyAcquisition({
      repository: this.#repository,
      apiUrl: this.#http.apiUrl,
      request: (pathname) => this.#get(pathname, CONCURRENCY_API_VERSION),
      readJson: (response) => this.#http.readJson(
        response,
        "GitHub ref store concurrency groups"
      )
    }, groupName);
  }

  async concurrencyMembers(
    groupName: string
  ): Promise<readonly GitHubConcurrencyMember[]> {
    requireConcurrencyGroup(groupName);
    const response = await this.#get(
      `repos/${this.#repository}/actions/concurrency_groups/`
        + encodeURIComponent(groupName),
      CONCURRENCY_API_VERSION
    );
    if (response.status !== 200) {
      throw new Error(
        `GitHub ref store returned ${response.status}`
          + " while reading concurrency group members"
      );
    }
    return parseConcurrencyMembers(
      await this.#http.readJson(
        response,
        "GitHub ref store concurrency group members"
      ),
      groupName
    );
  }

  async collaboratorPermission(login: string): Promise<string> {
    if (!LOGIN.test(login)) {
      throw new Error("GitHub ref store collaborator login is invalid");
    }
    const response = await this.#get(
      `repos/${this.#repository}/collaborators/${encodeURIComponent(login)}/permission`
    );
    if (response.status !== 200) {
      throw new Error(
        `GitHub ref store returned ${response.status}`
          + " while reading collaborator permission"
      );
    }
    const value = object(
      await this.#http.readJson(response, "GitHub ref store collaborator permission"),
      "GitHub ref store collaborator permission"
    );
    const user = object(value.user, "GitHub ref store collaborator");
    if (user.login !== login || typeof value.permission !== "string") {
      throw new Error("GitHub ref store returned malformed collaborator permission");
    }
    return value.permission;
  }

  async serverTime(): Promise<number> {
    const response = await this.#get("rate_limit");
    if (response.status !== 200) {
      throw new Error(
        `GitHub ref store returned ${response.status} while reading server time`
      );
    }
    const value = response.headers.get("date");
    const milliseconds = value === null ? Number.NaN : Date.parse(value);
    if (!Number.isSafeInteger(milliseconds)
      || new Date(milliseconds).toUTCString() !== value) {
      throw new Error("GitHub ref store returned an invalid server time");
    }
    await this.#http.readJson(response, "GitHub ref store server time");
    return milliseconds;
  }

  #get(pathname: string, apiVersion?: string): Promise<Response> {
    return this.#http.request(
      pathname,
      { method: "GET", apiVersion },
      "GitHub ref store"
    );
  }
}

function workflowRun(value: unknown): GitHubWorkflowRun {
  const record = object(value, "GitHub ref store workflow run");
  const repository = object(
    record.repository,
    "GitHub ref store workflow run repository"
  );
  if (!Number.isSafeInteger(record.id) || !Number.isSafeInteger(record.run_attempt)
    || typeof record.name !== "string" || typeof record.path !== "string"
    || typeof record.display_title !== "string" || typeof record.event !== "string"
    || typeof record.status !== "string" || typeof record.head_sha !== "string"
    || typeof repository.full_name !== "string") {
    throw new Error("GitHub ref store returned a malformed workflow run");
  }
  return Object.freeze({
    id: record.id as number,
    run_attempt: record.run_attempt as number,
    name: record.name,
    path: record.path,
    display_title: record.display_title,
    event: record.event,
    status: record.status,
    conclusion: record.conclusion,
    head_branch: record.head_branch,
    head_sha: record.head_sha,
    repository: Object.freeze({ full_name: repository.full_name })
  });
}

function workflowJob(value: unknown): GitHubWorkflowJob {
  const record = object(value, "GitHub ref store workflow job");
  if (!Number.isSafeInteger(record.id) || !Number.isSafeInteger(record.run_id)
    || typeof record.name !== "string" || typeof record.status !== "string") {
    throw new Error("GitHub ref store returned a malformed workflow job");
  }
  return Object.freeze({
    id: record.id as number,
    run_id: record.run_id as number,
    name: record.name,
    status: record.status,
    conclusion: record.conclusion
  });
}

function requireRunId(runId: string): void {
  if (!/^[1-9]\d{0,15}$/u.test(runId)
    || !Number.isSafeInteger(Number(runId))) {
    throw new Error("GitHub ref store workflow run ID is invalid");
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
