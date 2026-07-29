import { GitHubRefStore } from "./release-github-ref-store.js";
import { currentTime } from "./release-npm-operation-config.js";
import { GitHubNpmOperationLeaseProof } from
  "./release-npm-operation-lease-proof.js";
import {
  npmOperationLeaseRef,
  npmOperationRevocationMessage,
  npmOperationRevokingMessage,
  npmOperationTagName,
  type NpmOperationLeaseRequest
} from "./release-npm-operation-lease-state.js";
import {
  createOrVerifyNpmOperationRef
} from "./release-npm-operation-ref-writer.js";

export interface NpmOperationRevocationService {
  revoke(request: NpmOperationLeaseRequest): Promise<void>;
}

export class GitHubNpmOperationRevocation
implements NpmOperationRevocationService {
  readonly #store: GitHubRefStore;
  readonly #proof: GitHubNpmOperationLeaseProof;
  readonly #serverTime: () => Promise<number>;

  constructor(options: {
    readonly store: GitHubRefStore;
    readonly proof: GitHubNpmOperationLeaseProof;
    readonly serverTime: () => Promise<number>;
  }) {
    this.#store = options.store;
    this.#proof = options.proof;
    this.#serverTime = options.serverTime;
  }

  async revoke(request: NpmOperationLeaseRequest): Promise<void> {
    let state = await this.#proof.soleActive(request);
    if (state.refs.has("revoked")) {
      await this.#proof.revocation(request);
      return;
    }
    if (!state.refs.has("revoking")) {
      const ref = npmOperationLeaseRef(request, "revoking");
      const tag = await this.#store.createAnnotatedTag(
        npmOperationTagName(ref),
        npmOperationRevokingMessage(request.sourceCommit),
        request.sourceCommit,
        "npm operation lease revoking"
      );
      await createOrVerifyNpmOperationRef(
        this.#store,
        ref,
        tag.sha,
        "tag",
        "npm operation lease revoking",
        async () => {
          await this.#proof.revoking(request);
        }
      );
    }
    const revoking = await this.#proof.revoking(request);
    state = await this.#proof.soleActive(request);
    if (state.refs.has("revoked")) {
      await this.#proof.revocation(request);
      return;
    }
    const ref = npmOperationLeaseRef(request, "revoked");
    const tag = await this.#store.createAnnotatedTag(
      npmOperationTagName(ref),
      npmOperationRevocationMessage(
        new Date(await currentTime(this.#serverTime)).toISOString(),
        revoking.object.sha,
        request.sourceCommit
      ),
      request.sourceCommit,
      "npm operation lease revocation"
    );
    await createOrVerifyNpmOperationRef(
      this.#store,
      ref,
      tag.sha,
      "tag",
      "npm operation lease revocation",
      async () => {
        await this.#proof.revocation(request);
      }
    );
  }
}
