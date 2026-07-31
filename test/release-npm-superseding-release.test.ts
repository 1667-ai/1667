import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PUBLISHED_PACKAGE_COUNT
} from "../shared/release-targets.js";
import type { GitHubRef } from "../scripts/release-github-ref-store.js";
import {
  runNpmTagOperation,
  type NpmTagOperationLease
} from "../scripts/release-npm-operations-cli.js";
import {
  npmQuarantineMessage,
  npmReleaseOperationPackageOrder,
  type NpmPackageTagState,
  type NpmTagRegistry
} from "../scripts/release-npm-operations.js";
import {
  recordNpmQuarantineNote
} from "../scripts/release-npm-quarantine-note.js";
import {
  proveNpmSupersedingRelease,
  type NpmSupersedingReleaseRefStore
} from "../scripts/release-npm-superseding-release.js";

const VERSION = "1.2.3";
const SUPERSEDING = "1.2.4";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLAIM = "a".repeat(64);
const INCIDENT = "https://github.com/1667-ai/1667/issues/111";
const COMPLETION = `refs/tags/released/v${SUPERSEDING}`;
const PACKAGE_ORDER = npmReleaseOperationPackageOrder("quarantine");

test("superseding proof uses the completion ref and all canonical packages", async () => {
  const refs = new FakeRefs([releaseRef(COMPLETION)]);
  const registry = new ProofRegistry();
  await proveNpmSupersedingRelease(proofOptions(refs, registry));
  assert.deepEqual(refs.prefixes, [
    `tags/released/v${SUPERSEDING}`,
    `tags/released/v${SUPERSEDING}`
  ]);
  assert.equal(PACKAGE_ORDER.length, PUBLISHED_PACKAGE_COUNT);
  assert.deepEqual(registry.inspections, PACKAGE_ORDER);
});

test("superseding proof requires a SemVer version", async () => {
  await assert.rejects(
    proveNpmSupersedingRelease({
      ...proofOptions(new FakeRefs([]), new ProofRegistry()),
      version: "v1.2.4"
    }),
    /version is not SemVer/u
  );
});

test("superseding proof requires the exact completed release ref", async () => {
  await assert.rejects(
    proveNpmSupersedingRelease(proofOptions(new FakeRefs([]), new ProofRegistry())),
    /is not complete/u
  );
});

test("superseding proof requires a completion ref that targets a commit", async () => {
  await assert.rejects(
    proveNpmSupersedingRelease(proofOptions(
      new FakeRefs([releaseRef(COMPLETION, "tag")]),
      new ProofRegistry()
    )),
    /is not complete/u
  );
});

test("superseding proof rejects a quarantined completed release", async () => {
  await assert.rejects(
    proveNpmSupersedingRelease(proofOptions(
      new FakeRefs([
        releaseRef(COMPLETION),
        releaseRef(`${COMPLETION}_quarantined`)
      ]),
      new ProofRegistry()
    )),
    /is quarantined/u
  );
});

test("superseding proof rejects one absent canonical package", async () => {
  const registry = new ProofRegistry();
  registry.states.set(PACKAGE_ORDER[2]!, { present: false, deprecated: null });
  await assert.rejects(
    proveNpmSupersedingRelease(proofOptions(
      new FakeRefs([releaseRef(COMPLETION)]),
      registry
    )),
    /does not contain/u
  );
});

test("superseding proof rejects one deprecated canonical package", async () => {
  const registry = new ProofRegistry();
  registry.states.set(PACKAGE_ORDER[3]!, {
    present: true,
    deprecated: "withdrawn"
  });
  await assert.rejects(
    proveNpmSupersedingRelease(proofOptions(
      new FakeRefs([releaseRef(COMPLETION)]),
      registry
    )),
    /is deprecated/u
  );
});

test("superseding proof rejects a registry response for another package", async () => {
  const registry = new ProofRegistry();
  registry.wrongPackage = PACKAGE_ORDER[1]!;
  await assert.rejects(
    proveNpmSupersedingRelease(proofOptions(
      new FakeRefs([releaseRef(COMPLETION)]),
      registry
    )),
    /wrong package/u
  );
});

test("superseding proof catches quarantine during package inspection", async () => {
  const refs = new FakeRefs([releaseRef(COMPLETION)]);
  const registry = new ProofRegistry();
  registry.afterInspect = (count) => {
    if (count === 3) {
      refs.nextRefs = [
        releaseRef(COMPLETION),
        releaseRef(`${COMPLETION}_quarantined`)
      ];
    }
  };
  await assert.rejects(
    proveNpmSupersedingRelease(proofOptions(refs, registry)),
    /is quarantined/u
  );
  assert.deepEqual(registry.inspections, PACKAGE_ORDER);
  assert.equal(refs.prefixes.length, 2);
});

test("quarantine operation proves the superseding release before npm writes", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-superseding-operation-"))
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const previousClaim = process.env.NPM_OPERATION_CLAIM_SECRET;
  process.env.NPM_OPERATION_CLAIM_SECRET = CLAIM;
  t.after(() => {
    if (previousClaim === undefined) delete process.env.NPM_OPERATION_CLAIM_SECRET;
    else process.env.NPM_OPERATION_CLAIM_SECRET = previousClaim;
  });
  const registry = new ProofRegistry(VERSION);
  let proofCalls = 0;
  await assert.rejects(
    runNpmTagOperation(operationRequest(root), {
      lease: operationLease(),
      access: { async verify() {} },
      registry: () => registry,
      assertProcessQuiescent: () => {},
      supersedingRelease: {
        async verify(version) {
          proofCalls += 1;
          assert.equal(version, SUPERSEDING);
          throw new Error("superseding proof rejected");
        }
      }
    }),
    /superseding proof rejected/u
  );
  assert.equal(proofCalls, 1);
  assert.deepEqual(registry.writes, []);
});

test("quarantine refreshes superseding proof before writes and finalization", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-superseding-refresh-"))
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const previousClaim = process.env.NPM_OPERATION_CLAIM_SECRET;
  process.env.NPM_OPERATION_CLAIM_SECRET = CLAIM;
  t.after(() => {
    if (previousClaim === undefined) delete process.env.NPM_OPERATION_CLAIM_SECRET;
    else process.env.NPM_OPERATION_CLAIM_SECRET = previousClaim;
  });
  const registry = new SuccessfulQuarantineRegistry();
  const proofWriteCounts: number[] = [];
  const authorizationTrace: string[] = [];

  await runNpmTagOperation(operationRequest(root), {
    lease: successfulOperationLease(() => {
      authorizationTrace.push(`verify:${registry.writes.length}`);
    }),
    access: { async verify() {} },
    registry: (authorizeWrite) => {
      registry.authorizeWrite = authorizeWrite;
      return registry;
    },
    assertProcessQuiescent: () => {},
    supersedingRelease: {
      async verify(version) {
        assert.equal(version, SUPERSEDING);
        proofWriteCounts.push(registry.writes.length);
        authorizationTrace.push(`proof:${registry.writes.length}`);
      }
    }
  });

  assert.deepEqual(proofWriteCounts, [
    0,
    ...Array.from({ length: PUBLISHED_PACKAGE_COUNT + 1 }, (_, index) => index)
  ]);
  assert.deepEqual(authorizationTrace, [
    "proof:0",
    ...Array.from({ length: PUBLISHED_PACKAGE_COUNT }, (_, index) => [
      `proof:${index}`,
      `verify:${index}`
    ]).flat(),
    `proof:${PUBLISHED_PACKAGE_COUNT}`
  ]);
});

test("quarantine note proves the superseding release before public notice", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-superseding-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  let annotated = false;
  await assert.rejects(
    recordNpmQuarantineNote({
      repository: "1667-ai/1667",
      token: "token",
      claimSecret: CLAIM,
      version: VERSION,
      journalPath: path.join(root, "journal.jsonl"),
      evidencePath,
      lease: operationRequest(root).lease
    }, {
      lease: {
        async verifySuccessfulWriter() {},
        async complete() { throw new Error("unexpected completion"); }
      },
      readJournal: () => Object.freeze({
        parameters: Object.freeze({
          operation: "quarantine" as const,
          quarantine: Object.freeze({
            incidentReference: INCIDENT,
            supersedingVersion: SUPERSEDING
          })
        }),
        packageOrder: Object.freeze([]),
        records: 1,
        sha256: "b".repeat(64),
        terminal: "complete" as const,
        writeAttempts: 0
      }),
      proveSupersedingRelease: async (version) => {
        assert.equal(version, SUPERSEDING);
        throw new Error("superseding proof rejected");
      },
      annotate: async () => {
        annotated = true;
        throw new Error("unexpected annotation");
      }
    }),
    /superseding proof rejected/u
  );
  assert.equal(annotated, false);
  await assert.rejects(readFile(evidencePath), hasCode("ENOENT"));
});

class FakeRefs implements NpmSupersedingReleaseRefStore {
  readonly prefixes: string[] = [];
  nextRefs: readonly GitHubRef[] | null = null;
  constructor(readonly refs: readonly GitHubRef[]) {}
  async matchingRefs(prefix: string): Promise<readonly GitHubRef[]> {
    this.prefixes.push(prefix);
    return this.prefixes.length === 1 || this.nextRefs === null
      ? this.refs
      : this.nextRefs;
  }
}

class ProofRegistry implements NpmTagRegistry {
  readonly inspections: string[] = [];
  readonly writes: string[] = [];
  readonly states = new Map<string, {
    present: boolean;
    deprecated: string | null;
  }>();
  wrongPackage: string | null = null;
  afterInspect: ((count: number) => void) | null = null;

  constructor(readonly inspectedVersion = SUPERSEDING) {}

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    assert.equal(version, this.inspectedVersion);
    this.inspections.push(name);
    this.afterInspect?.(this.inspections.length);
    const state = this.states.get(name) ?? { present: true, deprecated: null };
    return Object.freeze({
      name: name === this.wrongPackage ? "@1667-ai/wrong" : name,
      version,
      present: state.present,
      deprecated: state.deprecated,
      tags: Object.freeze({ next: version })
    });
  }

  async addTag(name: string): Promise<void> {
    this.writes.push(`add:${name}`);
  }

  async removeTag(name: string): Promise<void> {
    this.writes.push(`remove:${name}`);
  }

  async deprecate(name: string): Promise<void> {
    this.writes.push(`deprecate:${name}`);
  }

  async settleAbsence(): Promise<void> {}
}

class SuccessfulQuarantineRegistry implements NpmTagRegistry {
  authorizeWrite: () => Promise<void> = async () => {};
  readonly writes: string[] = [];
  readonly #deprecated = new Set<string>();

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    assert.equal(version, VERSION);
    return Object.freeze({
      name,
      version,
      present: true,
      deprecated: this.#deprecated.has(name)
        ? npmQuarantineMessage({
            supersedingVersion: SUPERSEDING,
            incidentReference: INCIDENT
          })
        : null,
      tags: Object.freeze({})
    });
  }

  async addTag(): Promise<void> {
    throw new Error("unexpected tag add");
  }

  async removeTag(): Promise<void> {
    throw new Error("unexpected tag removal");
  }

  async deprecate(name: string): Promise<void> {
    await this.authorizeWrite();
    this.writes.push(name);
    this.#deprecated.add(name);
  }

  async settleAbsence(): Promise<void> {}
}

function proofOptions(
  refs: NpmSupersedingReleaseRefStore,
  registry: NpmTagRegistry
): Parameters<typeof proveNpmSupersedingRelease>[0] {
  return Object.freeze({
    repository: "1667-ai/1667",
    token: "token",
    version: SUPERSEDING,
    refs,
    registry
  });
}

function releaseRef(
  ref: string,
  type = "commit"
): GitHubRef {
  return Object.freeze({
    ref,
    object: Object.freeze({ type, sha: COMMIT })
  });
}

function operationRequest(root: string): Parameters<typeof runNpmTagOperation>[0] {
  return Object.freeze({
    command: "quarantine",
    version: VERSION,
    evidencePath: path.join(root, "journal.jsonl"),
    processJournalPath: path.join(root, "processes.jsonl"),
    lease: Object.freeze({
      repository: "1667-ai/1667",
      runId: "12345",
      runAttempt: "2",
      operation: "quarantine",
      version: VERSION,
      sourceCommit: COMMIT
    }),
    parameters: Object.freeze({
      operation: "quarantine",
      quarantine: Object.freeze({
        incidentReference: INCIDENT,
        supersedingVersion: SUPERSEDING
      })
    })
  });
}

function operationLease(): NpmTagOperationLease {
  const lease: NpmTagOperationLease = {
    async acquireWriter() {},
    async verifyWriter() {},
    async acknowledgeWriter(_request, _secret, outcome) {
      assert.equal(outcome, "failed");
    },
    async complete() {
      throw new Error("unexpected completion");
    },
    async fail() {}
  };
  return Object.freeze(lease);
}

function successfulOperationLease(
  onVerify: () => void = () => {}
): NpmTagOperationLease {
  const lease: NpmTagOperationLease = {
    async acquireWriter() {},
    async verifyWriter() {
      onVerify();
    },
    async acknowledgeWriter(_request, _secret, outcome) {
      assert.equal(outcome, "success");
    },
    async complete() {
      throw new Error("unexpected completion");
    },
    async fail() {
      throw new Error("unexpected failure");
    }
  };
  return Object.freeze(lease);
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof Error
    && "code" in error
    && error.code === expected;
}
