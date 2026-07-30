import { GitHubRefStore } from "./release-github-ref-store.js";
import { currentTime } from "./release-npm-operation-config.js";
import { GitHubNpmOperationLeaseProof } from
  "./release-npm-operation-lease-proof.js";
import {
  npmOperationLeaseRef,
  npmOperationTagName,
  npmOperationTerminalMessage,
  NpmOperationRefNotYetVisibleError,
  type NpmOperationLeaseRequest,
  type NpmOperationLeaseTerminal
} from "./release-npm-operation-lease-state.js";
import { GitHubNpmOperationOpen } from "./release-npm-operation-open.js";
import type { NpmOperationRevocationService } from
  "./release-npm-operation-revocation.js";
import {
  createOrVerifyNpmOperationRef
} from "./release-npm-operation-ref-writer.js";
import {
  requireNpmOperationRevocationSettled
} from "./release-npm-operation-revocation-settlement.js";

const COMPLETE_FINALIZATION = Object.freeze({
  terminal: "complete" as const,
  writerOutcome: "success" as const,
  authorization: "release" as const
});
const FAILED_FINALIZATION = Object.freeze({
  terminal: "failed" as const,
  writerOutcome: "failed" as const,
  authorization: "none" as const
});

type NpmOperationFinalization =
  | typeof COMPLETE_FINALIZATION
  | typeof FAILED_FINALIZATION;

export class GitHubNpmOperationFinalizer {
  readonly #store: GitHubRefStore;
  readonly #proof: GitHubNpmOperationLeaseProof;
  readonly #open: GitHubNpmOperationOpen;
  readonly #verifyControls: () => Promise<void>;
  readonly #authorizeRelease: (request: NpmOperationLeaseRequest) => Promise<void>;
  readonly #revocation: NpmOperationRevocationService;
  readonly #serverTime: () => Promise<number>;

  constructor(options: {
    readonly store: GitHubRefStore;
    readonly proof: GitHubNpmOperationLeaseProof;
    readonly open: GitHubNpmOperationOpen;
    readonly verifyControls: () => Promise<void>;
    readonly authorizeRelease:
      (request: NpmOperationLeaseRequest) => Promise<void>;
    readonly revocation: NpmOperationRevocationService;
    readonly serverTime: () => Promise<number>;
  }) {
    this.#store = options.store;
    this.#proof = options.proof;
    this.#open = options.open;
    this.#verifyControls = options.verifyControls;
    this.#authorizeRelease = options.authorizeRelease;
    this.#revocation = options.revocation;
    this.#serverTime = options.serverTime;
  }

  async complete(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void> {
    await this.#finish(request, claimSecret, COMPLETE_FINALIZATION);
  }

  async fail(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void> {
    await this.#finish(request, claimSecret, FAILED_FINALIZATION);
  }

  async abandon(request: NpmOperationLeaseRequest): Promise<void> {
    const terminal = await this.#proof.terminalOutcomeForRequest(request);
    if (terminal !== null) {
      if (terminal !== "abandoned") {
        throw new Error("npm operation lease terminal outcome changed");
      }
      await this.#open.release(request);
      return;
    }
    const revocation = await this.#proof.revocation(request);
    requireNpmOperationRevocationSettled(
      revocation.record.revokedAt,
      await currentTime(this.#serverTime)
    );
    await this.#createTerminal(request, "abandoned", revocation.ref.object.sha);
  }

  async #finish(
    request: NpmOperationLeaseRequest,
    claimSecret: string,
    finalization: NpmOperationFinalization
  ): Promise<void> {
    const existing = await this.#proof.terminalOutcomeForRequest(request);
    if (existing !== null) {
      if (existing !== finalization.terminal) {
        throw new Error("npm operation lease terminal outcome changed");
      }
      await this.#open.release(request);
      return;
    }
    const proof = await this.#proof.writerOutcome(
      request,
      finalization.writerOutcome
    );
    if (finalization.authorization === "release") {
      await this.#authorizeRelease(request);
    }
    await this.#revocation.revoke(request);
    const revocationTagSha = await this.#proof.finalizationRevocation(
      request,
      claimSecret,
      proof
    );
    if (revocationTagSha === null) {
      throw new Error("npm operation lease finalization has no revocation");
    }
    await this.#createTerminal(
      request,
      finalization.terminal,
      revocationTagSha
    );
  }

  async #createTerminal(
    request: NpmOperationLeaseRequest,
    outcome: NpmOperationLeaseTerminal,
    revocationTagSha: string
  ): Promise<void> {
    await this.#verifyControls();
    const ref = npmOperationLeaseRef(request, "terminal");
    const tag = await this.#store.createAnnotatedTag(
      npmOperationTagName(ref),
      npmOperationTerminalMessage(outcome, revocationTagSha),
      request.sourceCommit,
      "npm operation lease terminal"
    );
    await createOrVerifyNpmOperationRef(
      this.#store,
      ref,
      tag.sha,
      "tag",
      "npm operation lease terminal",
      async () => {
        const actual = await this.#proof.terminalOutcomeForRequest(request);
        if (actual === null) {
          throw new NpmOperationRefNotYetVisibleError(
            "npm operation lease terminal marker is absent"
          );
        }
        if (actual !== outcome) {
          throw new Error("npm operation lease terminal outcome changed");
        }
      }
    );
    await this.#open.release(request);
  }
}
