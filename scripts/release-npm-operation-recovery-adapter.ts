import { randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  open,
  readFile,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../server/canonical-json.js";
import { GitHubRefStore } from "./release-github-ref-store.js";
import { GitHubHttpTransport } from "./release-github-http.js";
import { GitHubWorkflowClient } from "./release-github-workflow-client.js";
import {
  requireNpmOperationTerminalHolderRun
} from "./release-npm-operation-holder-authorization.js";
import {
  findSnapshot,
  GitHubNpmOperationLeaseProof
} from "./release-npm-operation-lease-proof.js";
import { GitHubNpmOperationLease } from "./release-npm-operation-lease.js";
import type {
  NpmOperationLeaseTerminal,
  NpmOperationLeaseRequest
} from "./release-npm-operation-lease-state.js";
import type {
  NpmOperationLeaseOrchestrator
} from "./release-npm-operation-orchestration.js";
import type {
  NpmOperationReconciliation
} from "./release-npm-operation-reconciliation.js";
import type {
  NpmOperationRecoveryInspection,
  NpmOperationRecoveryLease
} from "./release-npm-operation-recovery.js";

export class GitHubNpmOperationRecovery
implements NpmOperationLeaseOrchestrator, NpmOperationRecoveryLease {
  readonly #lease: GitHubNpmOperationLease;
  readonly #store: GitHubRefStore;
  readonly #workflow: GitHubWorkflowClient;
  readonly #proof: GitHubNpmOperationLeaseProof;

  constructor(options: {
    readonly repository: string;
    readonly token: string;
    readonly apiUrl?: string;
  }) {
    this.#lease = new GitHubNpmOperationLease(options);
    const http = new GitHubHttpTransport({
      token: options.token,
      apiUrl: options.apiUrl,
      maxResponseBytes: 1024 * 1024,
      userAgent: "1667-release-npm-operation-recovery"
    });
    this.#store = new GitHubRefStore(options, http);
    this.#workflow = new GitHubWorkflowClient(options.repository, http);
    this.#proof = new GitHubNpmOperationLeaseProof(
      this.#store,
      options.repository
    );
  }

  claim(request: NpmOperationLeaseRequest, secret: string): Promise<void> {
    return this.#lease.claim(request, secret);
  }

  openState() {
    return this.#lease.openState();
  }

  revoke(request: NpmOperationLeaseRequest): Promise<void> {
    return this.#lease.revoke(request);
  }

  abandon(request: NpmOperationLeaseRequest): Promise<void> {
    return this.#lease.abandon(request);
  }

  cleanupOpen(request: NpmOperationLeaseRequest): Promise<void> {
    return this.#lease.cleanupOpen(request);
  }

  assertNoActiveWithVerifiedControls(): Promise<void> {
    return this.#lease.assertNoActiveWithVerifiedControls();
  }

  assertNoWriterAfterRevocation(
    request: NpmOperationLeaseRequest
  ): Promise<void> {
    return this.#lease.assertNoWriterAfterRevocation(request);
  }

  writerOutcome(request: NpmOperationLeaseRequest) {
    return this.#lease.writerOutcome(request);
  }

  complete(
    request: NpmOperationLeaseRequest,
    claimSecret: string
  ): Promise<void> {
    return this.#lease.complete(request, claimSecret);
  }

  terminalOutcome(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationLeaseTerminal | null> {
    return this.#proof.terminalOutcomeForRequest(request);
  }

  async inspect(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationRecoveryInspection> {
    const open = await this.#lease.openState();
    if (open !== null) {
      requireSameRequest(open.request, request);
      return open;
    }
    const snapshot = findSnapshot(await this.#proof.snapshots(request), request);
    if (snapshot !== undefined) {
      if (snapshot.request.sourceCommit !== request.sourceCommit) {
        throw new Error("npm operation lease targets a different source commit");
      }
      if (!snapshot.refs.has("terminal")) {
        throw new Error("npm operation active marker has no open marker");
      }
      await this.#proof.terminalOutcome(snapshot);
      return Object.freeze({ request, state: "terminal" });
    }
    requireNpmOperationTerminalHolderRun(
      await this.#workflow.workflowRun(request.runId),
      request
    );
    return Object.freeze({ request, state: "pre-active-cleaned" });
  }
}

export async function writeNpmOperationReconciliation(
  file: string,
  value: NpmOperationReconciliation
): Promise<void> {
  const bytes = `${canonicalJson(value)}\n`;
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) {
    if (!existing.isFile() || existing.isSymbolicLink()
      || await readFile(file, "utf8") !== bytes) {
      throw new Error("npm operation reconciliation record changed");
    }
    await chmod(file, 0o600);
    return;
  }
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(16).toString("hex")}.tmp`
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, file);
  } catch (error) {
    const raced = await readFile(file, "utf8").catch(() => null);
    if (raced !== bytes) throw error;
  } finally {
    await unlink(temporary);
  }
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function requireSameRequest(
  actual: NpmOperationLeaseRequest,
  expected: NpmOperationLeaseRequest
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("npm operation open marker does not match the recovery request");
  }
}
