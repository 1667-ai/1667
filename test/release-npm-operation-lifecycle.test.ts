import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  runNpmTagOperation,
  type NpmTagOperationLease,
  type OperationCliRequest
} from "../scripts/release-npm-operations-cli.js";
import type {
  NpmPackageTagState,
  NpmTagRegistry
} from "../scripts/release-npm-operations.js";

const VERSION = "1.2.3";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CLAIM = "a".repeat(64);

test("operation request rejects each mismatched lifecycle coordinate", async (t) => {
  const root = await temporaryRoot(t);
  const request = promotionRequest(root);
  const cases = [
    {
      request: { ...request, command: "invalid" },
      error: /command is invalid/u
    },
    {
      request: {
        ...request,
        parameters: {
          operation: "quarantine",
          quarantine: {
            incidentReference: "https://github.com/1667-ai/1667/issues/111",
            supersedingVersion: "1.2.4"
          }
        }
      },
      error: /coordinates do not match/u
    },
    {
      request: {
        ...request,
        lease: { ...request.lease, operation: "quarantine" }
      },
      error: /coordinates do not match/u
    },
    {
      request: {
        ...request,
        lease: { ...request.lease, version: "1.2.4" }
      },
      error: /coordinates do not match/u
    },
    {
      request: {
        ...request,
        lease: { ...request.lease, sourceCommit: "not-a-commit" }
      },
      error: /source commit is invalid/u
    }
  ] as const;

  for (const fixture of cases) {
    await assert.rejects(
      runNpmTagOperation(
        fixture.request as unknown as OperationCliRequest
      ),
      fixture.error
    );
  }
});

test("writer recovery records failure before registry construction completes",
  async (t) => {
  const root = await temporaryRoot(t);
  const request = promotionRequest(root);
  const previous = process.env.NPM_OPERATION_CLAIM_SECRET;
  process.env.NPM_OPERATION_CLAIM_SECRET = CLAIM;
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_OPERATION_CLAIM_SECRET;
    else process.env.NPM_OPERATION_CLAIM_SECRET = previous;
  });
  const calls: string[] = [];
  const lease: NpmTagOperationLease = {
    async acquireWriter(_request, claimSecret) {
      assert.equal(claimSecret, CLAIM);
      calls.push("writer");
    },
    async verifyWriter() {
      throw new Error("writer verification must not start");
    },
    async acknowledgeWriter(_request, _writerSecret, outcome) {
      calls.push(`acknowledge-${outcome}`);
    },
    async complete() {
      throw new Error("completion must not start");
    },
    async fail(_request, claimSecret) {
      assert.equal(claimSecret, CLAIM);
      calls.push("fail");
    }
  };

  await assert.rejects(
    runNpmTagOperation(request, {
      lease,
      access: {
        async verify() {
          throw new Error("access verification must not start");
        }
      },
      registry: () => {
        throw new Error("registry construction failed");
      },
      assertProcessQuiescent: () => {}
    }),
    /registry construction failed/u
  );

  assert.deepEqual(calls, ["writer", "acknowledge-failed", "fail"]);
  const records = (await readFile(request.evidencePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as {
      record: string;
      failure?: { observationErrors?: readonly unknown[] };
    });
  assert.equal(records.at(-1)?.record, "failed");
  assert.equal(records.at(-1)?.failure?.observationErrors?.length, 5);
});

test("writer acquisition failure does not start unowned recovery", async (t) => {
  const root = await temporaryRoot(t);
  const request = promotionRequest(root);
  restoreClaimSecret(t);
  const calls: string[] = [];
  const lease = recoveryLease(calls);
  lease.acquireWriter = async () => {
    calls.push("writer");
    throw new Error("writer acquisition failed");
  };

  await assert.rejects(
    runNpmTagOperation(request, {
      lease,
      access: { async verify() {} },
      registry: () => {
        throw new Error("registry must not be constructed");
      },
      assertProcessQuiescent: () => {}
    }),
    /writer acquisition failed/u
  );
  assert.deepEqual(calls, ["writer"]);
  const records = (await readFile(request.evidencePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { record: string });
  assert.deepEqual(records.map((record) => record.record), ["started"]);
});

test("registry-ready recovery records fresh public observations", async (t) => {
  const root = await temporaryRoot(t);
  const request = promotionRequest(root);
  restoreClaimSecret(t);
  const calls: string[] = [];

  await assert.rejects(
    runNpmTagOperation(request, {
      lease: recoveryLease(calls),
      access: { async verify() {} },
      registry: () => new FailingRegistry(),
      assertProcessQuiescent: () => {}
    }),
    /registry observation failed/u
  );

  assert.deepEqual(calls, ["writer", "acknowledge-failed", "fail"]);
  const records = (await readFile(request.evidencePath, "utf8"))
    .trimEnd()
    .split("\n");
  const failed = JSON.parse(records.at(-1)!) as {
    failure: {
      observationErrors: readonly { message: string }[];
    };
  };
  assert.equal(failed.failure.observationErrors.length, 5);
  assert.deepEqual(
    new Set(failed.failure.observationErrors.map((error) => error.message)),
    new Set(["registry observation failed"])
  );
});

test("recovery stops before lease failure when acknowledgment is not durable",
  async (t) => {
  const root = await temporaryRoot(t);
  const request = promotionRequest(root);
  restoreClaimSecret(t);
  const calls: string[] = [];
  const lease = recoveryLease(calls);
  lease.acknowledgeWriter = async () => {
    calls.push("acknowledge-failed");
    throw new Error("acknowledgment failed");
  };

  await assert.rejects(
    runNpmTagOperation(request, {
      lease,
      access: { async verify() {} },
      registry: () => {
        throw new Error("registry construction failed");
      },
      assertProcessQuiescent: () => {}
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /recovery records are incomplete/u);
      assert.deepEqual(
        error.errors.map((entry) => String(entry)),
        [
          "Error: registry construction failed",
          "Error: acknowledgment failed"
        ]
      );
      return true;
    }
  );
  assert.deepEqual(calls, ["writer", "acknowledge-failed"]);
});

function promotionRequest(root: string): Extract<
  OperationCliRequest,
  { readonly command: "promote" }
> {
  return Object.freeze({
    command: "promote",
    version: VERSION,
    evidencePath: path.join(root, "evidence.jsonl"),
    processJournalPath: path.join(root, "processes.jsonl"),
    lease: Object.freeze({
      repository: "1667-ai/1667",
      runId: "12345",
      runAttempt: "2",
      operation: "promotion",
      version: VERSION,
      sourceCommit: COMMIT
    }),
    parameters: Object.freeze({
      operation: "promotion",
      promotion: Object.freeze({
        destination: "latest",
        stableAcknowledged: false
      })
    })
  });
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "1667-operation-lifecycle-"))
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

function restoreClaimSecret(t: TestContext): void {
  const previous = process.env.NPM_OPERATION_CLAIM_SECRET;
  process.env.NPM_OPERATION_CLAIM_SECRET = CLAIM;
  t.after(() => {
    if (previous === undefined) delete process.env.NPM_OPERATION_CLAIM_SECRET;
    else process.env.NPM_OPERATION_CLAIM_SECRET = previous;
  });
}

function recoveryLease(calls: string[]): NpmTagOperationLease {
  return {
    async acquireWriter() {
      calls.push("writer");
    },
    async verifyWriter() {},
    async acknowledgeWriter(_request, _writerSecret, outcome) {
      calls.push(`acknowledge-${outcome}`);
    },
    async complete() {
      throw new Error("completion must not start");
    },
    async fail() {
      calls.push("fail");
    }
  };
}

class FailingRegistry implements NpmTagRegistry {
  async inspect(): Promise<NpmPackageTagState> {
    throw new Error("registry observation failed");
  }

  async settleAbsence(): Promise<void> {}

  async addTag(): Promise<void> {
    throw new Error("write must not start");
  }

  async removeTag(): Promise<void> {
    throw new Error("write must not start");
  }

  async deprecate(): Promise<void> {
    throw new Error("write must not start");
  }
}
