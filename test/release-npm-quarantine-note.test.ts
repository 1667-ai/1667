import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJson } from "../server/canonical-json.js";
import {
  recordNpmQuarantineNote,
  type NpmQuarantineNoteLease,
  type NpmQuarantineNoteRequest
} from "../scripts/release-npm-quarantine-note.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLAIM = "a".repeat(64);
const EVIDENCE = Object.freeze({
  schemaVersion: 1 as const,
  notice: "release-notes" as const,
  releaseId: 17,
  tag: "v1.2.3",
  incidentReference: "https://github.com/1667-ai/1667/issues/111",
  supersedingVersion: "1.2.4",
  notesSha256: "b".repeat(64),
  assetsSha256: "c".repeat(64)
});
const JOURNAL = Object.freeze({
  parameters: Object.freeze({
    operation: "quarantine" as const,
    quarantine: Object.freeze({
      incidentReference: EVIDENCE.incidentReference,
      supersedingVersion: EVIDENCE.supersedingVersion
    })
  }),
  packageOrder: Object.freeze([]),
  records: 4,
  sha256: "d".repeat(64),
  terminal: "complete" as const,
  writeAttempts: 0
});

test("quarantine verifies, annotates, records, and then completes the lease", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "release-note.json");
  const calls: string[] = [];
  const request = operationRequest(evidencePath);
  const lease: NpmQuarantineNoteLease = {
    async verifySuccessfulWriter(leaseRequest, secret) {
      assert.equal(leaseRequest, request.lease);
      assert.equal(secret, CLAIM);
      calls.push("verify");
    },
    async complete(leaseRequest, secret) {
      assert.equal(leaseRequest, request.lease);
      assert.equal(secret, CLAIM);
      const started = JSON.parse(
        (await readFile(evidencePath, "utf8")).trim()
      ) as { record: string };
      const completed = JSON.parse(
        (await readFile(`${evidencePath}.complete`, "utf8")).trim()
      ) as { record: string };
      assert.deepEqual(
        [started.record, completed.record],
        ["started", "complete"]
      );
      calls.push("complete");
    }
  };

  const result = await recordNpmQuarantineNote(request, {
    proveSupersedingRelease: async () => {},
    lease,
    readJournal: () => JOURNAL,
    syncDirectory: async () => {
      calls.push("sync");
    },
    annotate: async (annotationRequest, quarantine) => {
      assert.equal(annotationRequest, request);
      assert.equal(quarantine, JOURNAL.parameters.quarantine);
      calls.push("annotate");
      return EVIDENCE;
    }
  });

  assert.deepEqual(result, EVIDENCE);
  assert.deepEqual(calls, [
    "verify",
    "sync",
    "annotate",
    "sync",
    "complete"
  ]);
  assert.equal((await readFile(evidencePath, "utf8")).endsWith("\n"), true);
});

test("quarantine does not annotate without a successful writer", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  let annotated = false;
  await assert.rejects(
    recordNpmQuarantineNote(operationRequest(path.join(root, "note.json")), {
      lease: {
        async verifySuccessfulWriter() { throw new Error("invalid claim"); },
        async complete() { throw new Error("unexpected completion"); }
      },
      readJournal: () => JOURNAL,
      annotate: async () => {
        annotated = true;
        return EVIDENCE;
      }
    }),
    /invalid claim/u
  );
  assert.equal(annotated, false);
});

test("an annotation failure leaves the lease active with a started record", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  let completed = false;
  await assert.rejects(
    recordNpmQuarantineNote(operationRequest(evidencePath), {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() { completed = true; }
      },
      readJournal: () => JOURNAL,
      annotate: async () => {
        throw new Error("annotation failed");
      }
    }),
    /annotation failed/u
  );
  assert.equal(
    (JSON.parse((await readFile(evidencePath, "utf8")).trim()) as {
      record: string;
    }).record,
    "started"
  );
  assert.equal(completed, false);
});

test("an exact existing record permits an idempotent completion retry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  const request = operationRequest(evidencePath);
  await assert.rejects(
    recordNpmQuarantineNote(request, {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() {}
      },
      readJournal: () => JOURNAL,
      annotate: async () => {
        throw new Error("simulated annotation interruption");
      }
    }),
    /simulated annotation interruption/u
  );
  let completed = false;
  await recordNpmQuarantineNote(request, {
    proveSupersedingRelease: async () => {},
    lease: {
      async verifySuccessfulWriter() {},
      async complete() { completed = true; }
    },
    readJournal: () => JOURNAL,
    annotate: async () => EVIDENCE
  });
  assert.equal(completed, true);
});

test("a terminal retry revalidates exact evidence before completion", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  const request = operationRequest(evidencePath);
  await assert.rejects(
    recordNpmQuarantineNote(request, {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() {
          throw new Error("open marker deletion failed");
        }
      },
      readJournal: () => JOURNAL,
      annotate: async () => EVIDENCE
    }),
    /open marker deletion failed/u
  );

  let completed = false;
  let annotations = 0;
  const result = await recordNpmQuarantineNote(request, {
    proveSupersedingRelease: async () => {},
    lease: {
      async verifySuccessfulWriter() {
        throw new Error("terminal writer must not be reverified");
      },
      async complete() {
        completed = true;
      }
    },
    readJournal: () => JOURNAL,
    annotate: async () => {
      annotations += 1;
      return EVIDENCE;
    }
  });

  assert.deepEqual(result, EVIDENCE);
  assert.equal(annotations, 1);
  assert.equal(completed, true);
});

test("a terminal retry rejects changed public notice evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  const request = operationRequest(evidencePath);
  await assert.rejects(
    recordNpmQuarantineNote(request, {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() { throw new Error("completion interrupted"); }
      },
      readJournal: () => JOURNAL,
      annotate: async () => EVIDENCE
    }),
    /completion interrupted/u
  );

  let completed = false;
  await assert.rejects(
    recordNpmQuarantineNote(request, {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {
          throw new Error("terminal writer must not be reverified");
        },
        async complete() { completed = true; }
      },
      readJournal: () => JOURNAL,
      annotate: async () => ({
        ...EVIDENCE,
        notesSha256: "e".repeat(64)
      })
    }),
    /notice does not match recorded evidence/u
  );
  assert.equal(completed, false);
});

test("a raced completion revalidates public notice evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  const request = operationRequest(evidencePath);
  let completed = false;

  await assert.rejects(
    recordNpmQuarantineNote(request, {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {
          await recordNpmQuarantineNote(request, {
            proveSupersedingRelease: async () => {},
            lease: {
              async verifySuccessfulWriter() {},
              async complete() {}
            },
            readJournal: () => JOURNAL,
            annotate: async () => EVIDENCE
          });
          throw new Error("writer became terminal");
        },
        async complete() { completed = true; }
      },
      readJournal: () => JOURNAL,
      annotate: async () => ({
        ...EVIDENCE,
        assetsSha256: "f".repeat(64)
      })
    }),
    /notice does not match recorded evidence/u
  );
  assert.equal(completed, false);
});

test("a conflicting record stops before annotation or lease completion", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  await writeFile(evidencePath, "{}\n", { mode: 0o600 });
  let completed = false;
  let annotated = false;
  await assert.rejects(
    recordNpmQuarantineNote(operationRequest(evidencePath), {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() { completed = true; }
      },
      readJournal: () => JOURNAL,
      annotate: async () => {
        annotated = true;
        return EVIDENCE;
      }
    }),
    /different operation/u
  );
  assert.equal(annotated, false);
  assert.equal(completed, false);
});

test("a truncated complete sidecar stops before annotation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  const request = operationRequest(evidencePath);
  await assert.rejects(
    recordNpmQuarantineNote(request, {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() { throw new Error("simulated completion crash"); }
      },
      readJournal: () => JOURNAL,
      annotate: async () => EVIDENCE
    }),
    /simulated completion crash/u
  );
  await writeFile(`${evidencePath}.complete`, "{\"record\":", { mode: 0o600 });
  let annotated = false;
  await assert.rejects(
    recordNpmQuarantineNote(request, {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() {}
      },
      readJournal: () => JOURNAL,
      annotate: async () => {
        annotated = true;
        return EVIDENCE;
      }
    }),
    /complete evidence is truncated/u
  );
  assert.equal(annotated, false);
});

test("a racing complete sidecar is not replaced", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const evidencePath = path.join(root, "note.json");
  const different = Object.freeze({ ...EVIDENCE, releaseId: 99 });
  const differentRecord = `${canonicalJson({
    schemaVersion: 1,
    record: "complete",
    evidence: different
  })}\n`;
  let completed = false;
  await assert.rejects(
    recordNpmQuarantineNote(operationRequest(evidencePath), {
      proveSupersedingRelease: async () => {},
      lease: {
        async verifySuccessfulWriter() {},
        async complete() { completed = true; }
      },
      readJournal: () => JOURNAL,
      annotate: async () => {
        await writeFile(`${evidencePath}.complete`, differentRecord, {
          flag: "wx",
          mode: 0o600
        });
        return EVIDENCE;
      }
    }),
    /different/u
  );
  assert.equal(completed, false);
  assert.equal(await readFile(`${evidencePath}.complete`, "utf8"), differentRecord);
});

test("quarantine evidence requires an absolute path", async () => {
  let verified = false;
  await assert.rejects(
    recordNpmQuarantineNote(operationRequest("note.json"), {
      lease: {
        async verifySuccessfulWriter() { verified = true; },
        async complete() {}
      },
      readJournal: () => JOURNAL,
      annotate: async () => EVIDENCE
    }),
    /path must be absolute/u
  );
  assert.equal(verified, false);
});

test("quarantine note rejects mismatched lease coordinates before proof", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "1667-quarantine-note-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const request = operationRequest(path.join(root, "note.json"));
  let verified = false;
  await assert.rejects(
    recordNpmQuarantineNote({
      ...request,
      lease: { ...request.lease, operation: "promotion" }
    }, {
      lease: {
        async verifySuccessfulWriter() { verified = true; },
        async complete() {}
      },
      readJournal: () => JOURNAL,
      annotate: async () => EVIDENCE
    }),
    /lease coordinates do not match/u
  );
  assert.equal(verified, false);
});

function operationRequest(evidencePath: string): NpmQuarantineNoteRequest {
  return Object.freeze({
    repository: "1667-ai/1667",
    token: "token",
    claimSecret: CLAIM,
    version: "1.2.3",
    journalPath: "/tmp/operation-journal.jsonl",
    evidencePath,
    lease: Object.freeze({
      repository: "1667-ai/1667",
      runId: "12345",
      runAttempt: "2",
      operation: "quarantine",
      version: "1.2.3",
      sourceCommit: COMMIT
    })
  });
}
