import type { GitHubAnnotatedTag, GitHubRef } from "./release-github-ref-store.js";
import { GitHubRefStore } from "./release-github-ref-store.js";
import {
  npmOperationLeaseIdentity,
  npmOperationOpenRef,
  npmOperationSecretMatches,
  parseNpmOperationClaimMessage,
  parseNpmOperationLeaseSnapshot,
  parseNpmOperationRevocationMessage,
  parseNpmOperationRevokingMessage,
  parseNpmOperationTerminalMessage,
  parseNpmOperationWriterMessage,
  parseNpmOperationWriterTerminalMessage,
  requireNpmOperationMarkerTag,
  requireNpmOperationSecret,
  type NpmOperationLeaseRequest,
  type NpmOperationRevocation,
  type NpmOperationLeaseSnapshot,
  type NpmOperationLeaseTerminal,
  type NpmOperationStoredMarker,
  type NpmOperationWriterOutcome
} from "./release-npm-operation-lease-state.js";

const OPEN_PREFIX = "tags/npm-operations-open/";

export class GitHubNpmOperationLeaseProof {
  readonly #store: GitHubRefStore;
  readonly #repository: string;

  constructor(store: GitHubRefStore, repository: string) {
    this.#store = store;
    this.#repository = repository;
  }

  async snapshots(
    request: NpmOperationLeaseRequest
  ): Promise<readonly NpmOperationLeaseSnapshot[]> {
    const prefix = `${npmOperationLeaseIdentity(request).slice("refs/".length)}/`;
    return parseNpmOperationLeaseSnapshot(
      await this.#store.matchingRefs(prefix),
      this.#repository
    );
  }

  async openRef(request: NpmOperationLeaseRequest): Promise<GitHubRef | null> {
    const refs = await this.#store.matchingRefs(OPEN_PREFIX);
    if (refs.length === 0) return null;
    if (refs.length !== 1) {
      throw new Error("More than one npm operation is open");
    }
    const ref = refs[0]!;
    if (ref.ref !== npmOperationOpenRef(request)
      || ref.object.type !== "commit"
      || ref.object.sha !== request.sourceCommit) {
      throw new Error("Another npm operation is open");
    }
    return ref;
  }

  async openRefs(): Promise<readonly GitHubRef[]> {
    return this.#store.matchingRefs(OPEN_PREFIX);
  }

  async soleActive(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationLeaseSnapshot> {
    const snapshots = await this.snapshots(request);
    const state = findSnapshot(snapshots, request);
    if (state === undefined || state.refs.has("terminal")) {
      throw new Error("npm operation lease is terminal or does not exist");
    }
    if (state.request.sourceCommit !== request.sourceCommit) {
      throw new Error("npm operation lease targets a different source commit");
    }
    if (await this.openRef(request) === null) {
      throw new Error("npm operation lease is not the sole active lease");
    }
    return state;
  }

  async terminalOutcomeForRequest(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationLeaseTerminal | null> {
    const state = findSnapshot(await this.snapshots(request), request);
    if (state === undefined) return null;
    if (state.request.sourceCommit !== request.sourceCommit) {
      throw new Error("npm operation lease targets a different source commit");
    }
    if (!state.refs.has("terminal")) return null;
    return this.terminalOutcome(state);
  }

  async claimIdentity(
    request: NpmOperationLeaseRequest,
    secret: string,
    expected: ReadonlyMap<NpmOperationStoredMarker, string> = new Map()
  ): Promise<GitHubRef> {
    requireNpmOperationSecret(secret);
    const state = await this.soleActive(request);
    const claim = requiredRef(state, "claimed");
    const digest = parseNpmOperationClaimMessage(
      (await this.#tag(state, "claimed")).message
    );
    if (!npmOperationSecretMatches(secret, digest)) {
      throw new Error("npm operation lease claim secret does not match");
    }
    await this.#finalProof(
      request,
      new Map([["claimed", claim.object.sha], ...expected]),
      ["revoking", "revoked"]
    );
    return claim;
  }

  async finalizationRevocation(
    request: NpmOperationLeaseRequest,
    secret: string,
    expected: ReadonlyMap<NpmOperationStoredMarker, string>
  ): Promise<string | null> {
    requireNpmOperationSecret(secret);
    const state = await this.soleActive(request);
    const claim = requiredRef(state, "claimed");
    const digest = parseNpmOperationClaimMessage(
      (await this.#tag(state, "claimed")).message
    );
    if (!npmOperationSecretMatches(secret, digest)) {
      throw new Error("npm operation lease claim secret does not match");
    }
    const revoking = state.refs.has("revoking");
    const revoked = state.refs.has("revoked");
    if (revoking !== revoked) {
      throw new Error("npm operation lease revocation is incomplete");
    }
    if (!revoked) {
      await this.#finalProof(
        request,
        new Map([["claimed", claim.object.sha], ...expected]),
        ["revoking", "revoked"]
      );
      return null;
    }
    const revocation = await this.revocation(request);
    const refreshed = await this.soleActive(request);
    const revokingRef = requiredRef(refreshed, "revoking");
    await this.#finalProof(request, new Map([
      ["claimed", claim.object.sha],
      ...expected,
      ["revoking", revokingRef.object.sha],
      ["revoked", revocation.ref.object.sha]
    ]));
    return revocation.ref.object.sha;
  }

  async validateClaim(request: NpmOperationLeaseRequest): Promise<void> {
    const state = await this.soleActive(request);
    const claim = requiredRef(state, "claimed");
    parseNpmOperationClaimMessage(
      (await this.#tag(state, "claimed")).message
    );
    await this.#finalProof(
      request,
      new Map([["claimed", claim.object.sha]])
    );
  }

  async writerIdentity(
    request: NpmOperationLeaseRequest,
    secret: string
  ): Promise<GitHubRef> {
    requireNpmOperationSecret(secret);
    const state = await this.soleActive(request);
    if (state.refs.has("revoking") || state.refs.has("revoked")) {
      throw new Error("npm operation lease writer is revoked");
    }
    if (state.refs.has("writer-terminal")) {
      throw new Error("npm operation lease writer is terminal");
    }
    const claim = requiredRef(state, "claimed");
    const writer = requiredRef(state, "writer");
    const message = parseNpmOperationWriterMessage(
      (await this.#tag(state, "writer")).message
    );
    if (message.claimTagSha !== claim.object.sha
      || !npmOperationSecretMatches(secret, message.secretSha256)) {
      throw new Error("npm operation lease writer secret does not match");
    }
    await this.#finalProof(
      request,
      new Map([["claimed", claim.object.sha], ["writer", writer.object.sha]]),
      ["writer-terminal", "revoking", "revoked"]
    );
    return writer;
  }

  async revoking(request: NpmOperationLeaseRequest): Promise<GitHubRef> {
    const state = await this.soleActive(request);
    const ref = requiredRef(state, "revoking");
    const sourceCommit = parseNpmOperationRevokingMessage(
      (await this.#tag(state, "revoking")).message
    );
    if (sourceCommit !== request.sourceCommit) {
      throw new Error("npm operation lease revoking source binding is invalid");
    }
    await this.#finalProof(request, new Map([["revoking", ref.object.sha]]));
    return ref;
  }

  async revocation(request: NpmOperationLeaseRequest): Promise<{
    readonly record: NpmOperationRevocation;
    readonly ref: GitHubRef;
  }> {
    const state = await this.soleActive(request);
    const revoking = requiredRef(state, "revoking");
    const ref = requiredRef(state, "revoked");
    const revokingSource = parseNpmOperationRevokingMessage(
      (await this.#tag(state, "revoking")).message
    );
    const record = parseNpmOperationRevocationMessage(
      (await this.#tag(state, "revoked")).message
    );
    if (revokingSource !== request.sourceCommit
      || record.revokingTagSha !== revoking.object.sha
      || record.sourceCommit !== request.sourceCommit) {
      throw new Error("npm operation lease revocation source binding is invalid");
    }
    await this.#finalProof(request, new Map([
      ["revoking", revoking.object.sha],
      ["revoked", ref.object.sha]
    ]));
    return Object.freeze({ record, ref });
  }

  async noWriterAfterRevocation(
    request: NpmOperationLeaseRequest
  ): Promise<void> {
    const revocation = await this.revocation(request);
    const state = await this.soleActive(request);
    const revoking = requiredRef(state, "revoking");
    const expected = new Map<NpmOperationStoredMarker, string>([
      ["revoking", revoking.object.sha],
      ["revoked", revocation.ref.object.sha]
    ]);
    const claim = state.refs.get("claimed");
    if (claim !== undefined) {
      parseNpmOperationClaimMessage((await this.#tag(state, "claimed")).message);
      expected.set("claimed", claim.object.sha);
    }
    await this.#finalProof(
      request,
      expected,
      ["writer", "writer-terminal"]
    );
  }

  async writerOutcome(
    request: NpmOperationLeaseRequest,
    outcome: NpmOperationWriterOutcome
  ): Promise<ReadonlyMap<NpmOperationStoredMarker, string>> {
    const state = await this.soleActive(request);
    const writer = requiredRef(state, "writer");
    const terminal = requiredRef(state, "writer-terminal");
    const message = parseNpmOperationWriterTerminalMessage(
      (await this.#tag(state, "writer-terminal")).message
    );
    if (message.outcome !== outcome || message.writerTagSha !== writer.object.sha) {
      throw new Error(`npm operation lease writer did not acknowledge ${outcome}`);
    }
    return new Map([
      ["writer", writer.object.sha],
      ["writer-terminal", terminal.object.sha]
    ]);
  }

  async readWriterOutcome(
    request: NpmOperationLeaseRequest
  ): Promise<NpmOperationWriterOutcome | null> {
    const state = await this.soleActive(request);
    if (!state.refs.has("writer-terminal")) return null;
    const claim = requiredRef(state, "claimed");
    const writer = requiredRef(state, "writer");
    const terminal = requiredRef(state, "writer-terminal");
    const writerMessage = parseNpmOperationWriterMessage(
      (await this.#tag(state, "writer")).message
    );
    const message = parseNpmOperationWriterTerminalMessage(
      (await this.#tag(state, "writer-terminal")).message
    );
    if (writerMessage.claimTagSha !== claim.object.sha
      || message.writerTagSha !== writer.object.sha) {
      throw new Error("npm operation lease writer acknowledgment is invalid");
    }
    await this.#finalProof(request, new Map([
      ["claimed", claim.object.sha],
      ["writer", writer.object.sha],
      ["writer-terminal", terminal.object.sha]
    ]));
    return message.outcome;
  }

  async terminalOutcome(
    state: NpmOperationLeaseSnapshot
  ): Promise<NpmOperationLeaseTerminal> {
    const terminal = parseNpmOperationTerminalMessage(
      (await this.#tag(state, "terminal")).message
    );
    const outcome = terminal.outcome;
    const revoking = requiredRef(state, "revoking");
    const revoked = requiredRef(state, "revoked");
    const revokingSource = parseNpmOperationRevokingMessage(
      (await this.#tag(state, "revoking")).message
    );
    const revocation = parseNpmOperationRevocationMessage(
      (await this.#tag(state, "revoked")).message
    );
    if (revokingSource !== state.request.sourceCommit
      || revocation.revokingTagSha !== revoking.object.sha
      || revocation.sourceCommit !== state.request.sourceCommit
      || terminal.revocationTagSha !== revoked.object.sha) {
      throw new Error("npm operation lease terminal has no valid revocation");
    }
    if (outcome !== "abandoned") {
      const expected = outcome === "complete" ? "success" : "failed";
      const claim = requiredRef(state, "claimed");
      parseNpmOperationClaimMessage((await this.#tag(state, "claimed")).message);
      const writer = requiredRef(state, "writer");
      const writerMessage = parseNpmOperationWriterMessage(
        (await this.#tag(state, "writer")).message
      );
      const message = parseNpmOperationWriterTerminalMessage(
        (await this.#tag(state, "writer-terminal")).message
      );
      if (writerMessage.claimTagSha !== claim.object.sha
        || message.outcome !== expected
        || message.writerTagSha !== writer.object.sha) {
        throw new Error("npm operation lease terminal has no matching writer outcome");
      }
    }
    return outcome;
  }

  async #tag(
    state: NpmOperationLeaseSnapshot,
    marker: Exclude<NpmOperationStoredMarker, "active">
  ): Promise<GitHubAnnotatedTag> {
    const ref = requiredRef(state, marker);
    const tag = await this.#store.getAnnotatedTag(
      ref.object.sha,
      `npm operation lease ${marker}`
    );
    requireNpmOperationMarkerTag(ref, tag, state.request, marker);
    return tag;
  }

  async #finalProof(
    request: NpmOperationLeaseRequest,
    expected: ReadonlyMap<NpmOperationStoredMarker, string>,
    forbidden: readonly NpmOperationStoredMarker[] = []
  ): Promise<void> {
    const state = await this.soleActive(request);
    for (const [marker, sha] of expected) {
      if (requiredRef(state, marker).object.sha !== sha) {
        throw new Error("npm operation lease final proof changed");
      }
    }
    if (forbidden.some((marker) => state.refs.has(marker))) {
      throw new Error("npm operation lease final proof became terminal");
    }
  }
}

export function findSnapshot(
  snapshots: readonly NpmOperationLeaseSnapshot[],
  request: NpmOperationLeaseRequest
): NpmOperationLeaseSnapshot | undefined {
  const key = npmOperationLeaseIdentity(request);
  return snapshots.find((snapshot) => snapshot.key === key);
}

export function unterminatedSnapshots(
  snapshots: readonly NpmOperationLeaseSnapshot[]
): readonly NpmOperationLeaseSnapshot[] {
  return snapshots.filter((snapshot) => !snapshot.refs.has("terminal"));
}

function requiredRef(
  state: NpmOperationLeaseSnapshot,
  marker: NpmOperationStoredMarker
): GitHubRef {
  const ref = state.refs.get(marker);
  if (ref === undefined) throw new Error(`npm operation lease has no ${marker} ref`);
  return ref;
}
