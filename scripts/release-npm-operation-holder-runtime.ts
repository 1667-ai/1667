import type {
  GitHubConcurrencyAcquisition
} from "./release-github-concurrency.js";
import { GitHubRefStore } from "./release-github-ref-store.js";
import { GitHubWorkflowClient } from "./release-github-workflow-client.js";
import {
  authorizeNpmOperationClaim
} from "./release-npm-operation-authorization.js";
import {
  authorizeNpmOperationHolder,
  NPM_OPERATION_CONCURRENCY_GROUP
} from "./release-npm-operation-holder-authorization.js";
import {
  positiveInteger
} from "./release-npm-operation-config.js";
import {
  NpmOperationUnclaimedDeadline,
  serverAnchoredNpmOperationDeadline,
  type NpmOperationDeadlineOptions
} from "./release-npm-operation-deadline.js";
import {
  findSnapshot,
  GitHubNpmOperationLeaseProof
} from "./release-npm-operation-lease-proof.js";
import type {
  NpmOperationLeaseRequest,
  NpmOperationLeaseTerminal
} from "./release-npm-operation-lease-state.js";

const DEFAULT_MAX_POLLS = 1_440;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_UNCLAIMED_POLLS = 12;

export class GitHubNpmOperationHolderRuntime {
  readonly #store: GitHubRefStore;
  readonly #workflow: GitHubWorkflowClient;
  readonly #proof: GitHubNpmOperationLeaseProof;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #pollIntervalMs: number;
  readonly #maxPolls: number;
  readonly #maxUnclaimedPolls: number;
  readonly #deadlineOptions: NpmOperationDeadlineOptions;
  readonly #setDeadline: (
    deadline: NpmOperationUnclaimedDeadline | undefined
  ) => void;

  constructor(options: {
    readonly store: GitHubRefStore;
    readonly workflow: GitHubWorkflowClient;
    readonly proof: GitHubNpmOperationLeaseProof;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly pollIntervalMs?: number;
    readonly maxPolls?: number;
    readonly maxUnclaimedPolls?: number;
    readonly deadlineOptions: NpmOperationDeadlineOptions;
    readonly setDeadline: (
      deadline: NpmOperationUnclaimedDeadline | undefined
    ) => void;
  }) {
    this.#store = options.store;
    this.#workflow = options.workflow;
    this.#proof = options.proof;
    this.#sleep = options.sleep ?? ((milliseconds) => {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      60_000,
      "npm operation lease poll interval"
    );
    this.#maxPolls = positiveInteger(
      options.maxPolls ?? DEFAULT_MAX_POLLS,
      DEFAULT_MAX_POLLS,
      "npm operation lease poll count"
    );
    this.#maxUnclaimedPolls = positiveInteger(
      options.maxUnclaimedPolls ?? DEFAULT_MAX_UNCLAIMED_POLLS,
      DEFAULT_MAX_POLLS,
      "npm operation lease unclaimed poll count"
    );
    this.#deadlineOptions = options.deadlineOptions;
    this.#setDeadline = options.setDeadline;
  }

  async startAndPoll(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationLeaseTerminal> {
    let deadline = new NpmOperationUnclaimedDeadline(this.#deadlineOptions);
    this.#setDeadline(deadline);
    let claimed = false;
    let unclaimedPolls = 0;
    try {
      let acquisition: GitHubConcurrencyAcquisition;
      try {
        acquisition = await this.#workflow.concurrencyAcquisition(
          NPM_OPERATION_CONCURRENCY_GROUP
        );
      } catch (error) {
        if (!deadline.signal.aborted) throw error;
        this.#setDeadline(undefined);
        const stale = findSnapshot(
          await this.#proof.snapshots(request),
          request
        );
        if (stale?.refs.has("claimed") !== true) {
          this.#setDeadline(deadline);
          deadline.requireTime();
        }
        acquisition = await this.#workflow.concurrencyAcquisition(
          NPM_OPERATION_CONCURRENCY_GROUP
        );
      }
      deadline = serverAnchoredNpmOperationDeadline(
        this.#deadlineOptions,
        acquisition,
        deadline.startedAt
      );
      if (deadline.signal.aborted) {
        this.#setDeadline(undefined);
        const stale = findSnapshot(
          await this.#proof.snapshots(request),
          request
        );
        if (stale?.refs.has("claimed") !== true) {
          this.#setDeadline(deadline);
          deadline.requireTime();
        }
        await authorizeNpmOperationHolder(
          this.#store,
          this.#workflow,
          request,
          acquisition
        );
        try {
          await this.#proof.validateClaim(request);
        } catch (error) {
          this.#setDeadline(deadline);
          deadline.requireTime();
          throw error;
        }
        claimed = true;
        this.#setDeadline(undefined);
      } else {
        this.#setDeadline(deadline);
        deadline.requireTime();
        await authorizeNpmOperationHolder(
          this.#store,
          this.#workflow,
          request,
          acquisition
        );
      }
      await authorizeNpmOperationClaim(this.#store, request);
      for (let poll = 0; poll < this.#maxPolls; poll += 1) {
        const snapshots = await this.#proof.snapshots(request);
        const own = findSnapshot(snapshots, request);
        const open = await this.#proof.openRef(request);
        if (own !== undefined) {
          if (own.request.sourceCommit !== request.sourceCommit) {
            throw new Error("npm operation lease targets a different source commit");
          }
          if (own.refs.has("terminal")) {
            const terminal = await this.#proof.terminalOutcome(own);
            if (open === null) return terminal;
            await this.#sleep(this.#pollIntervalMs);
            continue;
          }
          if (open === null) {
            throw new Error("npm operation lease is not the sole active lease");
          }
        }
        if (!claimed && own?.refs.has("claimed") === true) {
          await this.#proof.validateClaim(request);
          claimed = true;
          this.#setDeadline(undefined);
        }
        if (!claimed) {
          deadline.requireTime();
          unclaimedPolls += 1;
          if (unclaimedPolls >= this.#maxUnclaimedPolls) {
            throw new Error("npm operation lease was not claimed before its deadline");
          }
        }
        await this.#sleep(claimed
          ? this.#pollIntervalMs
          : deadline.boundedInterval(this.#pollIntervalMs));
      }
      throw new Error("npm operation lease active marker did not settle");
    } catch (error) {
      if (!claimed && deadline.signal.aborted) {
        deadline.requireTime();
      }
      throw error;
    } finally {
      this.#setDeadline(undefined);
    }
  }
}
