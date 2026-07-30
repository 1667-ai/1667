import { GitHubRefStore, type GitHubRef } from "./release-github-ref-store.js";
import { GitHubWorkflowClient } from "./release-github-workflow-client.js";
import {
  findSnapshot,
  GitHubNpmOperationLeaseProof
} from "./release-npm-operation-lease-proof.js";
import {
  npmOperationOpenRef,
  NpmOperationRefNotYetVisibleError,
  type NpmOperationLeaseRequest
} from "./release-npm-operation-lease-state.js";
import {
  requireNpmOperationTerminalHolderRun
} from "./release-npm-operation-holder-authorization.js";
import {
  createOrVerifyNpmOperationRef
} from "./release-npm-operation-ref-writer.js";

export class GitHubNpmOperationOpen {
  readonly #store: GitHubRefStore;
  readonly #workflow: GitHubWorkflowClient;
  readonly #proof: GitHubNpmOperationLeaseProof;
  readonly #verifyControls: () => Promise<void>;

  constructor(
    store: GitHubRefStore,
    workflow: GitHubWorkflowClient,
    proof: GitHubNpmOperationLeaseProof,
    verifyControls: () => Promise<void>
  ) {
    this.#store = store;
    this.#workflow = workflow;
    this.#proof = proof;
    this.#verifyControls = verifyControls;
  }

  async acquire(
    request: NpmOperationLeaseRequest,
    signal?: AbortSignal
  ): Promise<void> {
    await this.#verifyControls();
    if (await this.#proof.openRef(request) !== null) return;
    await createOrVerifyNpmOperationRef(
      this.#store,
      npmOperationOpenRef(request),
      request.sourceCommit,
      "commit",
      "npm operation open marker",
      async () => {
        if (await this.#proof.openRef(request) === null) {
          throw new NpmOperationRefNotYetVisibleError(
            "npm operation open marker is absent"
          );
        }
      },
      { signal }
    );
  }

  async release(request: NpmOperationLeaseRequest): Promise<void> {
    await this.#verifyControls();
    const open = await this.#proof.openRef(request);
    if (open === null) return;
    const label = "npm operation open marker";
    try {
      await this.#store.deleteRef(open.ref, label);
    } catch (error) {
      if (await this.#exactRef(request, open.object.sha) === null) return;
      throw error;
    }
    if (await this.#exactRef(request, open.object.sha) !== null) {
      throw new Error("npm operation open marker was not deleted");
    }
  }

  async assertClear(): Promise<void> {
    const open = await this.#proof.openRefs();
    if (open.length !== 0) {
      throw new Error(`npm operation lease ${open[0]!.ref} is active`);
    }
  }

  async assertControlledClear(): Promise<void> {
    await this.#verifyControls();
    await this.assertClear();
  }

  async cleanup(request: NpmOperationLeaseRequest): Promise<void> {
    await this.#verifyControls();
    if (await this.#proof.openRef(request) === null) return;
    const state = findSnapshot(await this.#proof.snapshots(request), request);
    if (state === undefined) {
      requireNpmOperationTerminalHolderRun(
        await this.#workflow.workflowRun(request.runId),
        request
      );
      await this.release(request);
      return;
    }
    if (!state.refs.has("terminal")) {
      throw new Error("npm operation lease is not terminal");
    }
    await this.#proof.terminalOutcome(state);
    await this.release(request);
  }

  async #exactRef(
    request: NpmOperationLeaseRequest,
    expectedSha: string
  ): Promise<GitHubRef | null> {
    const ref = await this.#store.getRef(
      npmOperationOpenRef(request),
      "npm operation open marker"
    );
    if (ref === null) return null;
    if (ref.object.type !== "commit" || ref.object.sha !== expectedSha
      || ref.object.sha !== request.sourceCommit) {
      throw new Error("npm operation open marker changed");
    }
    return ref;
  }
}
