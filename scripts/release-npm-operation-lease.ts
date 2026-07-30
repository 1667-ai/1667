import { GitHubRefStore } from "./release-github-ref-store.js";
import { GitHubHttpTransport } from "./release-github-http.js";
import { GitHubWorkflowClient } from "./release-github-workflow-client.js";
import { verifyNpmOperationRepositoryControls } from
  "./release-npm-operation-controls.js";
import {
  authorizeNpmOperationClaim,
  authorizeNpmOperationRelease
} from "./release-npm-operation-authorization.js";
import {
  findSnapshot,
  GitHubNpmOperationLeaseProof
} from "./release-npm-operation-lease-proof.js";
import {
  npmOperationClaimMessage,
  npmOperationLeaseRef,
  parseNpmOperationOpenRequest,
  npmOperationSecretDigest,
  npmOperationTagName,
  npmOperationWriterMessage,
  npmOperationWriterTerminalMessage,
  requireNpmOperationLeaseRequest,
  requireNpmOperationSecret,
  NpmOperationRefNotYetVisibleError,
  type NpmOperationLeaseRequest,
  type NpmOperationOpenState,
  type NpmOperationLeaseTerminal,
  type NpmOperationWriterOutcome
} from "./release-npm-operation-lease-state.js";
import {
  authorizeNpmOperationHolder,
  authorizeNpmOperationHolderRun,
  NPM_OPERATION_CONCURRENCY_GROUP,
  requireNpmOperationDispatcherPermission,
  requireNpmOperationTerminalHolderRun
} from "./release-npm-operation-holder-authorization.js";
import {
  type GitHubNpmOperationLeaseOptions
} from "./release-npm-operation-config.js";
import {
  NpmOperationUnclaimedDeadline,
  serverAnchoredNpmOperationDeadline,
  type NpmOperationDeadlineOptions
} from "./release-npm-operation-deadline.js";
import {
  GitHubNpmOperationHolderRuntime
} from "./release-npm-operation-holder-runtime.js";
import { GitHubNpmOperationFinalizer } from
  "./release-npm-operation-finalizer.js";
import { GitHubNpmOperationOpen } from "./release-npm-operation-open.js";
import { GitHubNpmOperationRevocation } from
  "./release-npm-operation-revocation.js";
import {
  createOrVerifyNpmOperationRef
} from "./release-npm-operation-ref-writer.js";

export type { NpmOperationLeaseOperation, NpmOperationLeaseRequest,
  NpmOperationLeaseTerminal, NpmOperationOpenState,
  NpmOperationWriterOutcome } from
  "./release-npm-operation-lease-state.js";
export type { GitHubNpmOperationLeaseOptions } from
  "./release-npm-operation-config.js";

export class GitHubNpmOperationLease {
  readonly #repository: string;
  readonly #store: GitHubRefStore;
  readonly #workflow: GitHubWorkflowClient;
  readonly #proof: GitHubNpmOperationLeaseProof;
  readonly #open: GitHubNpmOperationOpen;
  readonly #revocation: GitHubNpmOperationRevocation;
  readonly #finalizer: GitHubNpmOperationFinalizer;
  readonly #holder: GitHubNpmOperationHolderRuntime;
  readonly #deadlineOptions: NpmOperationDeadlineOptions;
  #unclaimedDeadline: NpmOperationUnclaimedDeadline | undefined;
  readonly #serverTime: () => Promise<number>;
  readonly #verifyControls: () => Promise<void>;

  constructor(options: GitHubNpmOperationLeaseOptions) {
    this.#repository = options.repository;
    const requestSignal = (): AbortSignal | undefined => {
      return this.#unclaimedDeadline?.signal;
    };
    const http = new GitHubHttpTransport({
      token: options.token,
      apiUrl: options.apiUrl,
      fetch: options.fetch,
      requestSignal,
      maxResponseBytes: 1024 * 1024,
      userAgent: "1667-release-npm-operation-lease"
    });
    this.#store = new GitHubRefStore({
      ...options,
      requestSignal
    }, http);
    this.#workflow = new GitHubWorkflowClient(this.#repository, http);
    this.#proof = new GitHubNpmOperationLeaseProof(this.#store, this.#repository);
    this.#deadlineOptions = Object.freeze({
      lockStartedAtMs: options.lockStartedAtMs,
      unclaimedTimeoutMs: options.unclaimedTimeoutMs,
      now: options.now
    });
    this.#serverTime = options.serverTime ?? (() => this.#workflow.serverTime());
    this.#verifyControls = options.verifyControls ?? (() => {
      return verifyNpmOperationRepositoryControls({
        repository: options.repository,
        token: options.token,
        apiUrl: options.apiUrl,
        fetch: options.fetch,
        requestSignal: () => this.#unclaimedDeadline?.signal
      });
    });
    this.#open = new GitHubNpmOperationOpen(
      this.#store,
      this.#workflow,
      this.#proof,
      this.#verifyControls
    );
    this.#holder = new GitHubNpmOperationHolderRuntime({
      store: this.#store,
      workflow: this.#workflow,
      proof: this.#proof,
      sleep: options.sleep,
      pollIntervalMs: options.pollIntervalMs,
      maxPolls: options.maxPolls,
      maxUnclaimedPolls: options.maxUnclaimedPolls,
      deadlineOptions: this.#deadlineOptions,
      setDeadline: (deadline) => {
        this.#unclaimedDeadline = deadline;
      }
    });
    this.#revocation = new GitHubNpmOperationRevocation({
      store: this.#store,
      proof: this.#proof,
      serverTime: this.#serverTime
    });
    this.#finalizer = new GitHubNpmOperationFinalizer({
      store: this.#store,
      proof: this.#proof,
      open: this.#open,
      verifyControls: this.#verifyControls,
      authorizeRelease: (request) => {
        return authorizeNpmOperationRelease(this.#store, request);
      },
      revocation: this.#revocation,
      serverTime: this.#serverTime
    });
  }

  async startAndPoll(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationLeaseTerminal> {
    return this.#holder.startAndPoll(this.#request(request));
  }

  async authorizeDispatch(
    request: NpmOperationLeaseRequest,
    dispatcher: string
  ): Promise<void> {
    const validated = this.#request(request);
    await authorizeNpmOperationHolderRun(
      this.#store,
      this.#workflow,
      validated
    );
    requireNpmOperationDispatcherPermission(
      await this.#workflow.collaboratorPermission(dispatcher)
    );
    await authorizeNpmOperationClaim(this.#store, validated);
  }
  async claim(request: NpmOperationLeaseRequest, secret: string): Promise<void> {
    const validated = this.#request(request);
    requireNpmOperationSecret(secret);
    const acquisition = await this.#workflow.concurrencyAcquisition(
      NPM_OPERATION_CONCURRENCY_GROUP
    );
    const deadline = serverAnchoredNpmOperationDeadline(
      this.#deadlineOptions,
      acquisition
    );
    this.#unclaimedDeadline = deadline;
    try {
      deadline.requireTime();
      await authorizeNpmOperationHolder(
        this.#store,
        this.#workflow,
        validated,
        acquisition
      );
      deadline.requireTime();
      await authorizeNpmOperationClaim(this.#store, validated);
      let snapshots = await this.#proof.snapshots(validated);
      let own = findSnapshot(snapshots, validated);
      if (own?.refs.has("terminal") === true) {
        throw new Error("npm operation lease cannot be claimed");
      }
      deadline.requireTime();
      await this.#open.acquire(validated, deadline.signal);
      deadline.requireTime();
      await authorizeNpmOperationHolder(this.#store, this.#workflow, validated);
      deadline.requireTime();
      if (own === undefined) {
        await createOrVerifyNpmOperationRef(
          this.#store,
          npmOperationLeaseRef(validated, "active"),
          validated.sourceCommit,
          "commit",
          "npm operation lease active",
          async () => {
            await this.#proof.soleActive(validated);
          },
          { signal: deadline.signal }
        );
        snapshots = await this.#proof.snapshots(validated);
        own = findSnapshot(snapshots, validated);
      }
      own = own ?? await this.#proof.soleActive(validated);
      if (own.request.sourceCommit !== validated.sourceCommit) {
        throw new Error("npm operation lease targets a different source commit");
      }
      if (own.refs.has("revoking") || own.refs.has("revoked")) {
        throw new Error("npm operation lease cannot be claimed");
      }
      deadline.requireTime();
      await authorizeNpmOperationHolder(this.#store, this.#workflow, validated);
      deadline.requireTime();
      if (own.refs.has("claimed")) {
        await this.verifyClaim(validated, secret);
        return;
      }
      const ref = npmOperationLeaseRef(validated, "claimed");
      const tag = await this.#store.createAnnotatedTag(
        npmOperationTagName(ref),
        npmOperationClaimMessage(npmOperationSecretDigest(secret)),
        validated.sourceCommit,
        "npm operation lease claim"
      );
      deadline.requireTime();
      await authorizeNpmOperationClaim(this.#store, validated);
      deadline.requireTime();
      await createOrVerifyNpmOperationRef(
        this.#store,
        ref,
        tag.sha,
        "tag",
        "npm operation lease claim",
        () => this.verifyClaim(validated, secret),
        { signal: deadline.signal }
      );
    } catch (error) {
      if (deadline.signal.aborted) deadline.requireTime();
      throw error;
    } finally {
      this.#unclaimedDeadline = undefined;
    }
  }

  async verifyClaim(
    request: NpmOperationLeaseRequest,
    secret: string
  ): Promise<void> {
    const validated = this.#request(request);
    await authorizeNpmOperationClaim(this.#store, validated);
    await this.#proof.claimIdentity(validated, secret);
  }

  async createQuarantineMarker(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void> {
    const validated = this.#request(request);
    if (validated.operation !== "quarantine") {
      throw new Error("npm quarantine marker requires a quarantine claim");
    }
    await authorizeNpmOperationClaim(this.#store, validated);
    await this.#proof.claimIdentity(validated, claimSecret);
    await createOrVerifyNpmOperationRef(
      this.#store,
      `refs/tags/released/v${validated.version}_quarantined`,
      validated.sourceCommit,
      "commit",
      "npm release quarantine marker",
      () => authorizeNpmOperationRelease(this.#store, validated)
    );
    await this.#proof.claimIdentity(validated, claimSecret);
  }

  async acquireWriter(
    request: NpmOperationLeaseRequest,
    claimSecret: string,
    writerSecret: string
  ): Promise<void> {
    const validated = this.#request(request);
    await authorizeNpmOperationRelease(this.#store, validated);
    const claim = await this.#proof.claimIdentity(validated, claimSecret);
    const ref = npmOperationLeaseRef(validated, "writer");
    const tag = await this.#store.createAnnotatedTag(
      npmOperationTagName(ref),
      npmOperationWriterMessage(
        npmOperationSecretDigest(writerSecret),
        claim.object.sha
      ),
      validated.sourceCommit,
      "npm operation lease writer"
    );
    await createOrVerifyNpmOperationRef(
      this.#store,
      ref,
      tag.sha,
      "tag",
      "npm operation lease writer",
      () => this.verifyWriter(validated, writerSecret)
    );
  }

  async verifyWriter(
    request: NpmOperationLeaseRequest,
    writerSecret: string
  ): Promise<void> {
    const validated = this.#request(request);
    await authorizeNpmOperationRelease(this.#store, validated);
    await this.#proof.writerIdentity(validated, writerSecret);
  }

  async acknowledgeWriter(
    request: NpmOperationLeaseRequest,
    writerSecret: string,
    outcome: NpmOperationWriterOutcome
  ): Promise<void> {
    const validated = this.#request(request);
    if (outcome === "success") {
      await authorizeNpmOperationRelease(this.#store, validated);
    }
    const writer = await this.#proof.writerIdentity(validated, writerSecret);
    const ref = npmOperationLeaseRef(validated, "writer-terminal");
    const tag = await this.#store.createAnnotatedTag(
      npmOperationTagName(ref),
      npmOperationWriterTerminalMessage(outcome, writer.object.sha),
      validated.sourceCommit,
      "npm operation lease writer terminal"
    );
    await createOrVerifyNpmOperationRef(
      this.#store,
      ref,
      tag.sha,
      "tag",
      "npm operation lease writer terminal",
      async () => {
        const actual = await this.#proof.readWriterOutcome(validated);
        if (actual === null) {
          throw new NpmOperationRefNotYetVisibleError(
            "npm operation lease writer terminal marker is absent"
          );
        }
        if (actual !== outcome) {
          throw new Error("npm operation lease writer acknowledgment changed");
        }
      }
    );
  }

  async verifySuccessfulWriter(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void> {
    const validated = this.#request(request);
    const proof = await this.#proof.writerOutcome(validated, "success");
    await authorizeNpmOperationRelease(this.#store, validated);
    await this.#proof.finalizationRevocation(
      validated,
      claimSecret,
      proof
    );
  }

  async writerOutcome(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationWriterOutcome | null> {
    return this.#proof.readWriterOutcome(this.#request(request));
  }

  async assertNoWriterAfterRevocation(
    request: NpmOperationLeaseRequest
  ): Promise<void> {
    await this.#proof.noWriterAfterRevocation(this.#request(request));
  }

  async complete(request: NpmOperationLeaseRequest, claimSecret: string): Promise<void> {
    await this.#finalizer.complete(this.#request(request), claimSecret);
  }

  async fail(request: NpmOperationLeaseRequest, claimSecret: string): Promise<void> {
    await this.#finalizer.fail(this.#request(request), claimSecret);
  }

  async revoke(request: NpmOperationLeaseRequest): Promise<void> {
    await this.#revocation.revoke(this.#request(request));
  }

  async abandon(request: NpmOperationLeaseRequest): Promise<void> {
    await this.#finalizer.abandon(this.#request(request));
  }

  async assertNoUnterminatedActive(): Promise<void> {
    await this.#open.assertClear();
  }

  async assertNoActiveWithVerifiedControls(): Promise<void> {
    await this.#open.assertControlledClear();
  }

  async openState(): Promise<NpmOperationOpenState | null> {
    await this.#verifyControls();
    const refs = await this.#proof.openRefs();
    if (refs.length === 0) return null;
    if (refs.length !== 1) {
      throw new Error("More than one npm operation is open");
    }
    const request = parseNpmOperationOpenRequest(refs[0]!, this.#repository);
    const run = await this.#workflow.workflowRun(request.runId);
    if (run.status === "completed") {
      requireNpmOperationTerminalHolderRun(run, request);
    } else {
      await authorizeNpmOperationHolder(this.#store, this.#workflow, request);
    }
    const snapshot = findSnapshot(await this.#proof.snapshots(request), request);
    if (snapshot === undefined) {
      return Object.freeze({ request, state: "pre-active" });
    }
    if (!snapshot.refs.has("terminal")) {
      await this.#proof.soleActive(request);
      return Object.freeze({ request, state: "active" });
    }
    await this.#proof.terminalOutcome(snapshot);
    return Object.freeze({ request, state: "terminal" });
  }

  async cleanupOpen(request: NpmOperationLeaseRequest): Promise<void> {
    await this.#open.cleanup(this.#request(request));
  }

  #request(request: NpmOperationLeaseRequest): NpmOperationLeaseRequest {
    return requireNpmOperationLeaseRequest(request, this.#repository);
  }

}
