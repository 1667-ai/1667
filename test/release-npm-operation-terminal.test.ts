import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runNpmTagOperation,
  type NpmTagOperationLease
} from "../scripts/release-npm-operations-cli.js";
import {
  recordNpmQuarantineNote
} from "../scripts/release-npm-quarantine-note.js";
import {
  npmReleaseOperationPackageOrder,
  type NpmPackageTagState,
  type NpmTagRegistry
} from "../scripts/release-npm-operations.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLAIM = "a".repeat(64);
const INCIDENT = "https://github.com/1667-ai/1667/issues/111";
const SUPERSEDING = "1.2.4";

test("successful npm quarantine waits for its public release notice", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-quarantine-terminal-"))
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const journal = path.join(root, "journal.jsonl");
  const previous = process.env.NPM_OPERATION_CLAIM_SECRET;
  process.env.NPM_OPERATION_CLAIM_SECRET = CLAIM;
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_OPERATION_CLAIM_SECRET;
    else process.env.NPM_OPERATION_CLAIM_SECRET = previous;
  });
  const calls: string[] = [];
  const lease: NpmTagOperationLease = {
    async acquireWriter(_request, claim) {
      assert.equal(claim, CLAIM);
      calls.push("writer");
    },
    async verifyWriter() {
      throw new Error("absent packages do not need npm writes");
    },
    async acknowledgeWriter(_request, _writer, outcome) {
      calls.push(`acknowledge-${outcome}`);
    },
    async complete() {
      calls.push("complete");
    },
    async fail() {
      throw new Error("unexpected failed lease");
    }
  };

  await runNpmTagOperation({
    command: "quarantine",
    version: VERSION,
    evidencePath: journal,
    processJournalPath: path.join(root, "processes.jsonl"),
    lease: {
      repository: "1667-ai/1667",
      runId: "12345",
      runAttempt: "2",
      operation: "quarantine",
      version: VERSION,
      sourceCommit: COMMIT
    },
    parameters: {
      operation: "quarantine",
      quarantine: {
        incidentReference: INCIDENT,
        supersedingVersion: SUPERSEDING
      }
    }
  }, {
    lease,
    access: { async verify() {} },
    registry: () => new AbsentRegistry(),
    assertProcessQuiescent: () => {},
    supersedingRelease: { async verify() {} }
  });

  assert.deepEqual(calls, ["writer", "acknowledge-success"]);
  const records = (await readFile(journal, "utf8")).trimEnd().split("\n");
  assert.equal(
    (JSON.parse(records.at(-1)!) as { record: string }).record,
    "complete"
  );

  const noteEvidence = path.join(root, "quarantine-note.jsonl");
  const noteCalls: string[] = [];
  await recordNpmQuarantineNote({
    repository: "1667-ai/1667",
    token: "token",
    claimSecret: CLAIM,
    version: VERSION,
    journalPath: journal,
    evidencePath: noteEvidence,
    lease: {
      repository: "1667-ai/1667",
      runId: "12345",
      runAttempt: "2",
      operation: "quarantine",
      version: VERSION,
      sourceCommit: COMMIT
    }
  }, {
    proveSupersedingRelease: async () => {},
    lease: {
      async verifySuccessfulWriter() {
        noteCalls.push("verify");
      },
      async complete() {
        noteCalls.push("complete");
      }
    },
    annotate: async (_request, quarantine) => {
      assert.deepEqual(quarantine, {
        incidentReference: INCIDENT,
        supersedingVersion: SUPERSEDING
      });
      noteCalls.push("annotate");
      return Object.freeze({
        schemaVersion: 1 as const,
        notice: "release-notes" as const,
        releaseId: 17,
        tag: `v${VERSION}`,
        incidentReference: INCIDENT,
        supersedingVersion: SUPERSEDING,
        notesSha256: "b".repeat(64),
        assetsSha256: "c".repeat(64)
      });
    }
  });
  assert.deepEqual(noteCalls, ["verify", "annotate", "complete"]);
});

class AbsentRegistry implements NpmTagRegistry {
  async settleAbsence(): Promise<void> {}

  async inspect(name: string, version: string): Promise<NpmPackageTagState> {
    assert.ok(npmReleaseOperationPackageOrder("quarantine").includes(name));
    return Object.freeze({
      name,
      version,
      present: false,
      deprecated: null,
      tags: Object.freeze({})
    });
  }

  async addTag(): Promise<void> {
    throw new Error("unexpected add");
  }

  async removeTag(): Promise<void> {
    throw new Error("unexpected removal");
  }

  async deprecate(): Promise<void> {
    throw new Error("unexpected deprecation");
  }
}
