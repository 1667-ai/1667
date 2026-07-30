import assert from "node:assert/strict";
import type {
  NpmOperationLeaseRequest,
  NpmOperationLeaseTerminal,
  NpmOperationWriterOutcome
} from "../scripts/release-npm-operation-lease.js";
import {
  npmOperationClaimMessage,
  npmOperationLeaseRef,
  npmOperationOpenRef,
  npmOperationRevocationMessage,
  npmOperationRevokingMessage,
  npmOperationSecretDigest,
  npmOperationTagName,
  npmOperationTerminalMessage,
  npmOperationWriterMessage,
  npmOperationWriterTerminalMessage,
  type NpmOperationStoredMarker
} from "../scripts/release-npm-operation-lease-state.js";
import type {
  GitHubAnnotatedTag,
  GitHubRef
} from "../scripts/release-github-ref-store.js";
import type {
  GitHubWorkflowRun
} from "../scripts/release-github-workflow-client.js";
import {
  freezeRef,
  HOLDER_COMMIT,
  jsonResponse,
  workflowRun
} from "./release-npm-operation-lease-fixture-values.js";

export class FakeGitHub {
  readonly #request: NpmOperationLeaseRequest;
  readonly #refs = new Map<string, GitHubRef>();
  readonly #tags = new Map<string, GitHubAnnotatedTag>();
  #tagCounter = 0;
  #workflow: GitHubWorkflowRun;
  #permission = "admin";
  #duplicateHoldJob = false;
  #holdJob: {
    readonly id: number;
    readonly run_id: number;
    readonly name: string;
    readonly status: string;
    readonly conclusion: unknown;
  };
  #cancelAfterActive = false;
  #tagReadHook: (() => void) | undefined;
  #activeCreateHook: (() => void) | undefined;
  readonly #beforeRefCreate = new Map<string, () => void>();
  readonly #afterRefCreate = new Map<string, () => void>();
  readonly #beforeRefDelete = new Map<string, () => void>();
  readonly #afterRefDelete = new Map<string, () => void>();
  #serverTime = () => Date.parse("2020-01-01T00:00:00.000Z");
  #concurrencyAcquiredAt = () => this.#serverTime();
  #concurrencyGroup = "release-npm";
  #concurrencyMemberChange: {
    readonly run_id?: number;
    readonly job_id?: number;
    readonly job_name?: string;
    readonly status?: string;
  } = {};
  readonly events: string[] = [];
  readonly urls: string[] = [];
  readonly apiVersions: string[] = [];

  constructor(request: NpmOperationLeaseRequest) {
    this.#request = request;
    this.#workflow = workflowRun(request);
    this.#holdJob = Object.freeze({
      id: 987654321,
      run_id: Number(request.runId),
      name: "hold",
      status: "in_progress",
      conclusion: null
    });
    this.addAbsoluteRef("refs/heads/main", "commit", HOLDER_COMMIT);
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const method = init?.method ?? "GET";
    this.urls.push(url.href);
    this.apiVersions.push(new Headers(init?.headers).get(
      "x-github-api-version"
    ) ?? "");
    if (method === "GET" && url.pathname === "/rate_limit") {
      this.events.push("GET server time");
      return jsonResponse(
        {},
        200,
        new Date(this.#serverTime()).toUTCString()
      );
    }
    if (method === "GET"
      && url.pathname.endsWith("/actions/concurrency_groups")) {
      this.events.push("GET concurrency groups");
      return jsonResponse({
        total_count: 1,
        concurrency_groups: [{
          group_name: this.#concurrencyGroup,
          group_url: `${url.origin}${url.pathname}/${this.#concurrencyGroup}`,
          last_acquired_at: new Date(this.#concurrencyAcquiredAt())
            .toISOString().replace(".000Z", "Z")
        }]
      }, 200, new Date(this.#serverTime()).toUTCString());
    }
    if (method === "GET"
      && url.pathname.includes("/actions/concurrency_groups/")) {
      this.events.push("GET concurrency group members");
      const group = decodeURIComponent(url.pathname.split(
        "/actions/concurrency_groups/"
      )[1]!);
      if (group !== this.#concurrencyGroup
        || url.search !== "") {
        return jsonResponse({ message: "not in group" }, 422);
      }
      const member = {
        run_id: this.#holdJob.run_id,
        job_id: this.#holdJob.id,
        job_name: this.#holdJob.name,
        status: this.#holdJob.status,
        ...this.#concurrencyMemberChange
      };
      return jsonResponse({
        group_name: this.#concurrencyGroup,
        total_count: 1,
        group_members: [member]
      }, 200);
    }
    if (method === "GET" && url.pathname.endsWith("/jobs")) {
      this.events.push("GET workflow jobs");
      const jobs = this.#duplicateHoldJob
        ? [this.#holdJob, Object.freeze({ ...this.#holdJob, id: 987654322 })]
        : [this.#holdJob];
      return jsonResponse({
        jobs,
        total_count: jobs.length
      }, 200);
    }
    if (method === "GET" && url.pathname.includes("/actions/runs/")) {
      this.events.push("GET workflow");
      return jsonResponse(this.#workflow, 200);
    }
    if (method === "GET" && url.pathname.includes("/collaborators/")) {
      this.events.push("GET collaborator permission");
      const login = decodeURIComponent(
        url.pathname.split("/collaborators/")[1]!.split("/")[0]!
      );
      return jsonResponse({
        permission: this.#permission,
        user: { login }
      }, 200);
    }
    const exactRef = "/git/ref/";
    if (method === "GET" && url.pathname.includes(exactRef)) {
      this.events.push("GET exact ref");
      const name = decodeURIComponent(
        url.pathname.slice(url.pathname.indexOf(exactRef) + exactRef.length)
      );
      const ref = this.#refs.get(`refs/${name}`);
      return ref === undefined
        ? jsonResponse({ message: "not found" }, 404)
        : jsonResponse(ref, 200);
    }
    const matching = "/git/matching-refs/";
    if (method === "GET" && url.pathname.includes(matching)) {
      this.events.push("GET refs");
      const prefix = decodeURIComponent(
        url.pathname.slice(url.pathname.indexOf(matching) + matching.length)
      );
      const values = [...this.#refs.values()].filter((ref) => {
        return ref.ref.startsWith(`refs/${prefix}`);
      });
      return jsonResponse(values, 200);
    }
    if (method === "GET" && url.pathname.includes("/git/tags/")) {
      this.events.push("GET tag");
      const sha = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      const tag = this.#tags.get(sha);
      assert.ok(tag);
      const hook = this.#tagReadHook;
      this.#tagReadHook = undefined;
      hook?.();
      return jsonResponse(tag, 200);
    }
    if (method === "POST" && url.pathname.endsWith("/git/tags")) {
      const body = JSON.parse(String(init?.body)) as {
        tag: string; message: string; object: string; type: string;
      };
      this.events.push(`POST tag ${body.tag.split("/").at(-1)}`);
      return jsonResponse(this.storeTag(body.tag, body.message, body.object), 201);
    }
    const deleteRef = "/git/refs/";
    if (method === "DELETE" && url.pathname.includes(deleteRef)) {
      const name = decodeURIComponent(
        url.pathname.slice(url.pathname.indexOf(deleteRef) + deleteRef.length)
      );
      const ref = `refs/${name}`;
      this.events.push(`DELETE ref ${ref.split("/").at(-1)}`);
      const beforeDelete = this.#beforeRefDelete.get(ref);
      this.#beforeRefDelete.delete(ref);
      beforeDelete?.();
      if (!this.#refs.delete(ref)) {
        return jsonResponse({ message: "not found" }, 404);
      }
      const afterDelete = this.#afterRefDelete.get(ref);
      this.#afterRefDelete.delete(ref);
      afterDelete?.();
      return new Response(null, { status: 204 });
    }
    assert.equal(method, "POST");
    const body = JSON.parse(String(init?.body)) as { ref: string; sha: string };
    const marker = body.ref.startsWith("refs/tags/npm-operations-open/")
      ? "open"
      : body.ref.split("/").at(-1)!;
    this.events.push(`POST ref ${marker}`);
    const beforeCreate = this.#beforeRefCreate.get(body.ref);
    this.#beforeRefCreate.delete(body.ref);
    beforeCreate?.();
    if (this.#refs.has(body.ref)) return jsonResponse({ message: "exists" }, 422);
    const type = this.#tags.has(body.sha) ? "tag" : "commit";
    const ref = freezeRef(body.ref, type, body.sha);
    this.#refs.set(body.ref, ref);
    if (marker === "active" && this.#cancelAfterActive) {
      this.#workflow = Object.freeze({
        ...this.#workflow,
        status: "completed",
        conclusion: "cancelled"
      });
    }
    if (marker === "active") {
      const activeCreateHook = this.#activeCreateHook;
      this.#activeCreateHook = undefined;
      activeCreateHook?.();
    }
    const afterCreate = this.#afterRefCreate.get(body.ref);
    this.#afterRefCreate.delete(body.ref);
    afterCreate?.();
    return jsonResponse(ref, 201);
  };

  changeWorkflow(change: Partial<GitHubWorkflowRun>): void {
    this.#workflow = Object.freeze({ ...this.#workflow, ...change });
  }

  changePermission(permission: string): void {
    this.#permission = permission;
  }

  changeHoldJob(change: {
    readonly id?: number;
    readonly run_id?: number;
    readonly name?: string;
    readonly status?: string;
    readonly conclusion?: unknown;
  }): void {
    this.#holdJob = Object.freeze({ ...this.#holdJob, ...change });
  }

  duplicateHoldJob(): void {
    this.#duplicateHoldJob = true;
  }

  cancelAfterActive(): void {
    this.#cancelAfterActive = true;
  }

  afterActiveCreate(run: () => void): void {
    this.#activeCreateHook = run;
  }

  beforeRefCreate(ref: string, run: () => void): void {
    this.#beforeRefCreate.set(ref, run);
  }

  afterRefCreate(ref: string, run: () => void): void {
    this.#afterRefCreate.set(ref, run);
  }

  afterRefDelete(ref: string, run: () => void): void {
    this.#afterRefDelete.set(ref, run);
  }

  beforeRefDelete(ref: string, run: () => void): void {
    this.#beforeRefDelete.set(ref, run);
  }

  afterNextTagRead(run: () => void): void {
    this.#tagReadHook = run;
  }

  setServerTime(serverTime: () => number): void {
    this.#serverTime = serverTime;
  }

  setConcurrencyAcquiredAt(acquiredAt: () => number): void {
    this.#concurrencyAcquiredAt = acquiredAt;
  }

  changeConcurrencyGroup(groupName: string): void {
    this.#concurrencyGroup = groupName;
  }

  changeConcurrencyMember(change: {
    readonly run_id?: number;
    readonly job_id?: number;
    readonly job_name?: string;
    readonly status?: string;
  }): void {
    this.#concurrencyMemberChange = Object.freeze({
      ...this.#concurrencyMemberChange,
      ...change
    });
  }

  addReleaseAuthorization(request: NpmOperationLeaseRequest): void {
    const suffix = request.operation === "quarantine" ? "_quarantined" : "";
    this.addAbsoluteRef(`refs/tags/released/v${request.version}${suffix}`,
      "commit", request.sourceCommit);
  }

  addCompletionAuthorization(request: NpmOperationLeaseRequest): void {
    this.addAbsoluteRef(
      `refs/tags/released/v${request.version}`,
      "commit",
      request.sourceCommit
    );
  }

  addClaim(request: NpmOperationLeaseRequest, secret: string): void {
    this.addOpen(request);
    this.addCommit(request, "active");
    this.addTag(request, "claimed",
      npmOperationClaimMessage(npmOperationSecretDigest(secret)));
  }

  addWriter(request: NpmOperationLeaseRequest, secret: string): void {
    const claimSha = this.refFor(request, "claimed").object.sha;
    this.addTag(request, "writer", npmOperationWriterMessage(
      npmOperationSecretDigest(secret), claimSha
    ));
  }

  addWriterTerminal(
    request: NpmOperationLeaseRequest,
    outcome: NpmOperationWriterOutcome
  ): void {
    this.addTag(request, "writer-terminal", npmOperationWriterTerminalMessage(
      outcome, this.refFor(request, "writer").object.sha
    ));
  }

  addRevocation(request: NpmOperationLeaseRequest, revokedAt: string): void {
    if (!this.hasFor(request, "revoking")) this.addRevoking(request);
    this.addTag(request, "revoked", npmOperationRevocationMessage(
      revokedAt,
      this.refFor(request, "revoking").object.sha,
      request.sourceCommit
    ));
  }

  addRevoking(request: NpmOperationLeaseRequest): void {
    this.addTag(
      request,
      "revoking",
      npmOperationRevokingMessage(request.sourceCommit)
    );
  }

  addTerminal(
    request: NpmOperationLeaseRequest,
    outcome: NpmOperationLeaseTerminal
  ): void {
    if (!this.hasFor(request, "revoked")) {
      this.addRevocation(request, "2026-07-29T00:00:00.000Z");
    }
    const revocation = this.refFor(request, "revoked").object.sha;
    this.addTag(
      request,
      "terminal",
      npmOperationTerminalMessage(outcome, revocation)
    );
    this.#refs.delete(npmOperationOpenRef(request));
  }

  addOpen(request: NpmOperationLeaseRequest): void {
    const ref = npmOperationOpenRef(request);
    this.#refs.set(ref, freezeRef(ref, "commit", request.sourceCommit));
  }

  addCommit(request: NpmOperationLeaseRequest, marker: "active"): void {
    this.#refs.set(
      npmOperationLeaseRef(request, marker),
      freezeRef(npmOperationLeaseRef(request, marker), "commit", request.sourceCommit)
    );
  }

  addOpaqueTag(
    request: NpmOperationLeaseRequest,
    marker: Exclude<NpmOperationStoredMarker, "active">
  ): void {
    this.#tagCounter += 1;
    const sha = this.#tagCounter.toString(16).padStart(40, "0");
    const ref = npmOperationLeaseRef(request, marker);
    this.#refs.set(ref, freezeRef(ref, "tag", sha));
  }

  addAbsoluteRef(ref: string, type: "commit" | "tag", sha: string): void {
    this.#refs.set(ref, freezeRef(ref, type, sha));
  }

  hasAbsoluteRef(ref: string): boolean {
    return this.#refs.has(ref);
  }

  removeAbsoluteRef(ref: string): void {
    this.#refs.delete(ref);
  }

  absoluteRef(ref: string): GitHubRef {
    const value = this.#refs.get(ref);
    assert.ok(value);
    return value;
  }

  refsNamed(ref: string): readonly GitHubRef[] {
    return [...this.#refs.values()].filter((entry) => entry.ref === ref);
  }

  addTag(
    request: NpmOperationLeaseRequest,
    marker: Exclude<NpmOperationStoredMarker, "active">,
    message: string
  ): void {
    const ref = npmOperationLeaseRef(request, marker);
    const tag = this.storeTag(
      npmOperationTagName(ref),
      message,
      request.sourceCommit
    );
    this.#refs.set(ref, freezeRef(ref, "tag", tag.sha));
  }

  storeTag(tag: string, message: string, target: string): GitHubAnnotatedTag {
    this.#tagCounter += 1;
    const sha = this.#tagCounter.toString(16).padStart(40, "0");
    const value = Object.freeze({
      sha, tag, message,
      object: Object.freeze({ type: "commit", sha: target })
    });
    this.#tags.set(sha, value);
    return value;
  }

  has(marker: NpmOperationStoredMarker): boolean {
    return this.hasFor(this.#request, marker);
  }

  hasFor(
    request: NpmOperationLeaseRequest,
    marker: NpmOperationStoredMarker
  ): boolean {
    return this.#refs.has(npmOperationLeaseRef(request, marker));
  }

  ref(marker: NpmOperationStoredMarker): GitHubRef {
    return this.refFor(this.#request, marker);
  }

  refFor(
    request: NpmOperationLeaseRequest,
    marker: NpmOperationStoredMarker
  ): GitHubRef {
    const value = this.#refs.get(npmOperationLeaseRef(request, marker));
    assert.ok(value);
    return value;
  }

  tagFor(marker: Exclude<NpmOperationStoredMarker, "active">): GitHubAnnotatedTag {
    const value = this.#tags.get(this.ref(marker).object.sha);
    assert.ok(value);
    return value;
  }

  refsWith(marker: NpmOperationStoredMarker): readonly GitHubRef[] {
    return [...this.#refs.values()].filter((ref) => ref.ref.endsWith(`/${marker}`));
  }

  writerOutcome(): NpmOperationWriterOutcome {
    return this.tagFor("writer-terminal").message.includes('"success"')
      ? "success" : "failed";
  }

  terminalOutcome(): NpmOperationLeaseTerminal {
    const message = this.tagFor("terminal").message;
    if (message.includes('"complete"')) return "complete";
    if (message.includes('"abandoned"')) return "abandoned";
    return "failed";
  }
}
