import assert from "node:assert/strict";
import test from "node:test";
import {
  requireNpmOperationLeaseRequest
} from "../scripts/release-npm-operation-lease-state.js";
import {
  readNpmOperationJournal,
  type NpmOperationReconciliationIdentity
} from "../scripts/release-npm-operation-journal-reader.js";
import {
  requireNpmProcessJournalIdentity
} from "../scripts/release-npm-process-journal.js";

const REPOSITORY = "1667-ai/1667";
const IDENTITY = Object.freeze({
  runId: "12345",
  runAttempt: "2",
  operation: "promotion" as const,
  version: "1.2.3",
  sourceCommit: "0123456789abcdef0123456789abcdef01234567"
});

test("all npm operation records reject an overbound version identity", () => {
  const identity = {
    ...IDENTITY,
    version: `1.2.3-${"a".repeat(128)}`
  };
  rejectEveryIdentity(identity, /npm operation version is invalid/u);
});

test("all npm operation records reject an unsafe run identity", () => {
  const identity = {
    ...IDENTITY,
    runId: "9007199254740992"
  };
  rejectEveryIdentity(identity, /npm operation run number is invalid/u);
});

function rejectEveryIdentity(
  identity: NpmOperationReconciliationIdentity,
  leaseError: RegExp
): void {
  assert.throws(
    () => requireNpmOperationLeaseRequest({
      repository: REPOSITORY,
      ...identity
    }, REPOSITORY),
    leaseError
  );
  assert.throws(
    () => requireNpmProcessJournalIdentity(identity),
    /npm process journal lease coordinates are invalid/u
  );
  assert.throws(
    () => readNpmOperationJournal("/journal-must-not-be-read", identity),
    /npm operation reconciliation identity is invalid/u
  );
}
